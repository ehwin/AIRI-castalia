import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  INDEX_HER_LINES,
  INDEX_MAX_CHARS,
  INDEX_PER_DAY,
  INDEX_RECENT_LINES,
  isTranscriptEntry,
  memoryName,
  shouldSkipIngest,
  useMemoryStore,
} from './memory'

/** Index lines only, so a test asserts content without the section headers. */
function linesOf(index: string) {
  return index.split('\n').filter(line => line.startsWith('- '))
}

describe('memory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps one entry per name on a card and lists it in the index', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'Favorite Game', description: 'Porridge games, mostly.', body: 'Porridge games.' }, 'airi')
    memory.write({ name: 'favorite-game', description: 'Minecraft, lately.', body: 'Minecraft.' }, 'airi')

    expect(memory.entries.map(entry => entry.name)).toEqual(['favorite-game'])
    expect(memory.indexFor('airi')).toBe('About you:\n- favorite-game: Minecraft, lately.')
    expect(memory.read('Favorite Game', 'airi')?.body).toBe('Minecraft.')
  })

  // ROOT CAUSE: resolution fell back to "the bank holds one persona", so a second card read the first card's facts
  // and wrote her moods into the same persona. Only a known alias may join two names now.
  it('gives a second card her own persona instead of folding it into the only bank persona', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'Birthday', description: 'Her birthday is June 27.', body: 'June 27.' }, 'airi')

    expect(memory.resolvePersona('default')).toBe('airi')
    expect(memory.resolvePersona('N_h4lzzOfl0AYehOR171-')).toBe('N_h4lzzOfl0AYehOR171-')
    expect(memory.indexFor('N_h4lzzOfl0AYehOR171-')).toBe('')
    expect(memory.indexFor('default')).toContain('June 27')
  })

  // The real bank has two cards: `default` (ReLU) and `N_h4lzzOfl0AYehOR171-` (尤诺). Every memory row
  // belongs to 尤诺's card id, and `airi` is only the character name written *inside* the card — not a
  // partition key. Two cards must never share one partition, so no fallback to "whatever the backend
  // currently writes" is allowed: switching to ReLU would have read 尤诺's memories.
  it('keys memories by card id and only follows an alias that has its own rows', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'Birthday', description: 'Hers is June 27.', body: 'June 27.' }, 'N_h4lzzOfl0AYehOR171-')

    expect(memory.resolvePersona('N_h4lzzOfl0AYehOR171-')).toBe('N_h4lzzOfl0AYehOR171-')
    expect(memory.indexFor(memory.resolvePersona('N_h4lzzOfl0AYehOR171-'))).toContain('June 27')

    // The other card has no rows, so it keeps its own empty partition instead of borrowing hers.
    expect(memory.resolvePersona('default')).toBe('default')
    expect(memory.indexFor('default')).toBe('')

    // An alias is followed only when the alias itself owns rows (the old `default` → `airi` layout).
    memory.write({ name: 'Tone', description: 'Quiet.', body: 'Quiet.' }, 'airi')
    expect(memory.resolvePersona('default')).toBe('airi')
  })

  // A card keeps its own memories. Only the owner makes one general, and then every card reads it.
  it('keeps memories on their card until the owner makes one general', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'nickname', description: 'The owner likes to be called Yumeka.', body: 'Yumeka.' }, 'airi')
    memory.write({ name: 'channel-rules', description: 'No spoilers in the channel.', body: 'No spoilers.' }, 'discord-host')

    expect(memory.indexFor('discord-host')).toBe('About you:\n- channel-rules: No spoilers in the channel.')
    expect(memory.read('nickname', 'discord-host')).toBeUndefined()

    memory.makeGeneral({ name: 'nickname', persona: 'airi' })

    expect(memory.indexFor('discord-host')).toBe([
      'About you:',
      '- channel-rules: No spoilers in the channel.',
      'About the owner:',
      '- nickname: The owner likes to be called Yumeka.',
    ].join('\n'))
    expect(memory.read('nickname', 'discord-host')?.body).toBe('Yumeka.')
    expect(memory.entries.filter(entry => entry.name === 'nickname').map(entry => entry.persona)).toEqual([undefined])
  })

  it('prefers the card own entry, forgets only its own, and refuses an empty name or body', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'tone', description: '', body: 'Calm.' }, 'airi')
    memory.makeGeneral({ name: 'tone', persona: 'airi' })
    memory.write({ name: 'tone', description: '', body: 'Short sentences.' }, 'focus')

    expect(memory.read('tone', 'focus')?.body).toBe('Short sentences.')
    expect(memory.forget('tone', 'focus').found).toBe(true)
    expect(memory.read('tone', 'focus')?.body).toBe('Calm.')
    // A general memory belongs to the owner, so a run cannot forget it.
    expect(memory.forget('tone', 'focus').found).toBe(false)
    expect(memory.write({ name: '!!', description: '', body: 'x' }, 'airi').entry).toBeUndefined()
    expect(memory.write({ name: 'x', description: '', body: ' ' }, 'airi').entry).toBeUndefined()
    expect(memoryName('  我的 猫咪！ ')).toBe('我的-猫咪')
  })

  // The backend writes one entry per finished turn named `mem-xxxxxxxx`, so the index was
  // mostly her own past register. A dialogue line is a transcript; prose under the same
  // generated name is a fact and used to disappear with it.
  it('keeps turn transcripts out of the index but still lets them be read', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'mother', description: 'The mother she lost to the black tide.', body: 'Sibyl.' }, 'airi')
    memory.write({ name: 'mem-43bf085e', description: '用户: 我睡不着 助手: 那正好来找我说话哦', body: '...' }, 'airi')
    memory.write({ name: 'evening', description: '用户: 晚安 助手: 嗯，睡吧。', body: '...' }, 'airi')

    expect(memory.indexFor('airi')).toBe('About you:\n- mother: The mother she lost to the black tide.')
    // Hidden from the index is not forgotten: recall and tools still address the entry.
    expect(memory.read('mem-43bf085e', 'airi')?.description).toContain('睡不着')
    expect(memory.entries).toHaveLength(3)
  })

  // Measured on the running bank: 51 lore facts arrived as `mem-<id>` prose rows and the old
  // name rule dropped every one of them, while the birthday fact sat in the bank unused.
  it('puts a prose fact that arrived under a generated name into the index', () => {
    const memory = useMemoryStore()
    const birthday = '官方档案里，我的生日一栏写的是「未知」。'
    memory.write({ name: 'mem-901c50de', description: birthday, body: birthday }, 'airi')

    const index = memory.indexFor('airi')
    expect(index).toContain(birthday)
    // No invented address: the line is the fact itself, not `mem-901c50de: …`.
    expect(index).not.toContain('mem-901c50de')
  })

  it('recognises a transcript by its dialogue line, not by its generated name', () => {
    expect(isTranscriptEntry({ name: 'mem-43bf085e', description: '用户: 晚安 助手: 睡吧' })).toBe(true)
    expect(isTranscriptEntry({ name: 'evening', description: '用户: 晚安' })).toBe(true)
    expect(isTranscriptEntry({ name: 'evening', description: 'User: good night' })).toBe(true)
    expect(isTranscriptEntry({ name: 'mother', description: 'The mother she lost.' })).toBe(false)
    // A fact that merely mentions the user elsewhere is not a transcript.
    expect(isTranscriptEntry({ name: 'note', description: 'The 用户 prefers short replies.' })).toBe(false)
    // Prose under a generated name is a fact, not a turn.
    expect(isTranscriptEntry({ name: 'mem-901c50de', description: '官方档案里，我的生日一栏写的是「未知」。' })).toBe(false)
  })

  // A mood label is a snapshot of one moment. Left in the prompt it competes with the live
  // psyche block and steers the next reply toward a feeling that already passed.
  it('keeps a remembered mood snapshot out of the index', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'mem-mood_ms9', description: '[情绪快照] 聊得很开心，情绪值：+8', body: 'x' }, 'airi')
    memory.write({ name: 'mother', description: 'The mother she lost.', body: 'Sibyl.' }, 'airi')

    expect(linesOf(memory.indexFor('airi'))).toEqual(['- mother: The mother she lost.'])
    expect(memory.entries).toHaveLength(2)
  })

  // A one-line goodbye carries no fact. Storing it buys a transcript entry that the
  // index then has to hide again, and it re-teaches the register the closing rule retires.
  it('skips storing a turn only when it is a goodbye answered in one line', () => {
    expect(shouldSkipIngest({ user: '我去洗澡了，先不聊啦', assistant: '嗯，去吧。' })).toBe(true)
    expect(shouldSkipIngest({ user: '晚安', assistant: '晚安，做个好梦。' })).toBe(true)
    // A long answer still carries something worth keeping.
    expect(shouldSkipIngest({
      user: '我睡了',
      assistant: '睡吧。对了，今天你说的那个渐近线我记住了，明天讲给你听。要是半夜醒了就喊我，我一直醒着，反正夜里过得很快。',
    })).toBe(false)
    // Not a goodbye at all.
    expect(shouldSkipIngest({ user: '我在学函数渐近线', assistant: '嗯。' })).toBe(false)
    // A question about leaving is not a goodbye, so it is stored like any other turn.
    expect(shouldSkipIngest({ user: '我去做饭了，你想吃什么？', assistant: '我不吃。' })).toBe(false)
  })

  // Measured on the running store: 32 of 270 entries had no description at all, and six
  // were paraphrases of one evening. Both shapes spend the prompt budget twice.
  it('drops a line with no description and collapses two entries that say the same thing', () => {
    const memory = useMemoryStore()
    memory.write({ name: '情感记忆-[自循环日记]', description: '', body: '[自循环日记] 情绪指数 +0.0' }, 'airi')
    memory.write({ name: '2026-11-01-a', description: 'She was too tired to do anything.', body: 'a' }, 'airi')
    memory.write({ name: '2026-11-01-b', description: 'She  was too tired to do  anything.', body: 'b' }, 'airi')
    memory.write({ name: 'mother', description: 'The mother she lost.', body: 'Sibyl.' }, 'airi')

    const index = memory.indexFor('airi')
    const lines = linesOf(index)

    expect(lines).toHaveLength(2)
    expect(index).toContain('- mother: The mother she lost.')
    expect(lines.some(line => line.includes('too tired'))).toBe(true)
    // Every entry still exists; only the index collapsed.
    expect(memory.entries).toHaveLength(4)
  })

  // 38 identity facts in the running bank share one importance and one date, so a plain
  // top-K is a coin flip between facts. The picker prefers a line that covers new ground.
  it('prefers a different fact over a near copy when filling the index', () => {
    const memory = useMemoryStore()
    memory.write({ name: 'a', description: '我出生在黎那汐塔的七丘，母亲西比尔从不让我受贵族规矩束缚。', body: 'a' }, 'airi')
    memory.write({ name: 'b', description: '我出生在黎那汐塔的七丘，母亲西比尔从不让我受贵族规矩约束。', body: 'b' }, 'airi')
    memory.write({ name: 'c', description: '我是第 127 位谕女，名册上记着我的音痕在左脚脚背。', body: 'c' }, 'airi')

    const lines = linesOf(memory.indexFor('airi'))
    // The near copy is one fact said twice: it does not buy a second line.
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('- a: 我出生在黎那汐塔的七丘，母亲西比尔从不让我受贵族规矩束缚。')
    expect(lines[1]).toContain('第 127 位谕女')
  })

  it('caps the index so one long memory store cannot flood the system prompt', () => {
    const memory = useMemoryStore()
    const facts = [
      '我的名字来自天后朱诺。',
      '我出生在月食那一夜。',
      '我的武器是月之环和月之弓。',
      '我在四方殿当谕女。',
      '母亲西比尔死在黑潮里。',
      '我的计划是把稳定锚喂给新王。',
      '我见过年幼的自己。',
      '奥古斯塔是我的同僚。',
      '我把手镯交给了漂泊者。',
      '七丘四年办一次角斗赛。',
      '谕女的预言具有绝对效力。',
      '黑潮没有实体。',
      '我以眼中所映之物为对价。',
      '我曾被人叫作忤逆的谕女。',
      '我最后从所有人的记忆里消失。',
    ]
    facts.forEach((description, index) => memory.write({ name: `fact-${index}`, description, body: 'x' }, 'airi'))

    expect(linesOf(memory.indexFor('airi'))).toHaveLength(INDEX_HER_LINES)
  })

  it('keeps the whole index inside its character budget', () => {
    const memory = useMemoryStore()
    for (let index = 0; index < INDEX_HER_LINES + INDEX_RECENT_LINES; index++) {
      memory.write({ name: `2026-10-1${index % 10}-a`, description: `细节很长的第 ${index} 条回忆，`.repeat(12), body: 'x' }, 'airi')
      memory.write({ name: `fact-${index}`, description: `我记住的第 ${index} 件事，`.repeat(14), body: 'x' }, 'airi')
    }

    expect(memory.indexFor('airi').length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
  })

  // The engine reruns a summary of one evening until several near-identical lines exist.
  it('lets one dated day contribute one line to the recent section', () => {
    const memory = useMemoryStore()
    for (const [suffix, description] of [
      ['a', 'She was too tired to do anything.'],
      ['b', 'She said she was exhausted and wanted to do nothing.'],
      ['c', 'She was worn out and skipped everything.'],
      ['d', 'She had no energy left for the day.'],
    ] as const)
      memory.write({ name: `2026-11-01 · ${suffix}`, description, body: 'x' }, 'airi')
    memory.write({ name: 'mother', description: 'The mother she lost.', body: 'Sibyl.' }, 'airi')

    const index = memory.indexFor('airi')
    const recent = index.split('\n').filter(line => line.startsWith('- 2026-11-01'))

    expect(recent).toHaveLength(INDEX_PER_DAY)
    expect(linesOf(index)).toHaveLength(INDEX_PER_DAY + 1)
    expect(memory.entries).toHaveLength(5)
  })
})

describe('memory store backend note', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // ROOT CAUSE:
  //
  // The row read "全部能力在线 · 自动情感实验门槛未开启（PSYCHE_FROM_VAD）：引擎不会从对话推进 psyche；
  // recordEmotion 工具只改界面与提示词状态，不写引擎 psyche". The head claimed a capability that the
  // tail denied, so a reader saw a contradiction instead of a status.
  it('names the unconnected emotion chain instead of claiming every capability', () => {
    const memory = useMemoryStore()
    memory.setBackend({
      transport: 'in-process',
      project: 'airi',
      character: 'N_h4lzzOfiOAYehOR1T',
      capabilities: { vadSweep: true, recall: true, search: true, facts: true, ingest: true, maintain: true, selfCycle: true, psyche: true },
      emotion: { autoFromVad: false, estimator: 'lexicon', note: 'PSYCHE_FROM_VAD 未开启：对话不会推进 psyche，recordEmotion 只写提示词' },
      checkedAt: Date.now(),
    })

    const note = memory.backendNote() ?? ''
    expect(note).toContain('记忆在线 · 情感链未接引擎')
    expect(note).not.toContain('全部能力在线')
    expect(note).toContain('PSYCHE_FROM_VAD 未开启')
  })

  // The automatic estimator stays off, but the model's judged emotion reaches the engine through the
  // explicit path. Saying "nothing is connected" there would be as wrong as the old claim.
  it('says the emotion reaches the engine by an explicit write when that path exists', () => {
    const memory = useMemoryStore()
    memory.setBackend({
      transport: 'in-process',
      capabilities: { vadSweep: true, recall: true, search: true, facts: true, ingest: true, maintain: true, selfCycle: true, psyche: true },
      emotion: { autoFromVad: false, explicit: true, estimator: 'lexicon', note: 'PSYCHE_FROM_VAD 未开启：对话不会自动推进 psyche，但 recordEmotion 会把模型判断的情绪写进引擎' },
      checkedAt: Date.now(),
    })

    const note = memory.backendNote() ?? ''
    expect(note).toContain('情感经显式写入')
    expect(note).not.toContain('未接引擎')
  })

  // Retries of one turn must land on one event: the engine drops a repeat key, and without the key
  // it counted the same sentence twice.
  it('forwards the caller event id to the backend', async () => {
    const memory = useMemoryStore()
    let seen: string | undefined
    memory.attachRemote({
      list: async () => [],
      save: async () => {},
      forget: async () => true,
      emotion: async (_vad, _reason, _persona, eventId) => {
        seen = eventId
        return { applied: true, reason: 'applied' }
      },
    })

    await memory.recordEmotion({ valence: 0.4, arousal: 0.2, dominance: 0.5 }, 'calm', 'airi', 'emotion:turn:s1:t7')

    expect(seen).toBe('emotion:turn:s1:t7')
  })

  // A refused psyche write is not a memory outage: recall, search and ingest still work, and the
  // "记忆后端异常" card used to appear for it.
  it('does not count a refused emotion write as a backend failure', async () => {
    const memory = useMemoryStore()
    memory.attachRemote({
      list: async () => [],
      save: async () => {},
      forget: async () => true,
      emotion: async () => { throw new Error('psyche write refused') },
    })

    const result = await memory.recordEmotion({ valence: 0.5, arousal: 0.1, dominance: 0.2 }, 'a good line')

    expect(result.applied).toBe(false)
    expect(result.reason).toContain('refused')
    expect(memory.remoteHealth.consecutiveFailures).toBe(0)
  })

  it('claims every capability when the emotion chain reaches the engine', () => {
    const memory = useMemoryStore()
    memory.setBackend({
      transport: 'in-process',
      capabilities: { vadSweep: true, recall: true, search: true, facts: true, ingest: true, maintain: true, selfCycle: true, psyche: true },
      emotion: { autoFromVad: true, estimator: 'model', note: '自动情感已开启，分析来自模型端点' },
      checkedAt: Date.now(),
    })

    expect(memory.backendNote()).toContain('全部能力在线')
  })
})
