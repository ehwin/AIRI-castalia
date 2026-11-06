import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openBank } from './index'

// 运行环境: Node 24 的 node:sqlite + vec0.dll（Electron 主进程同样可用，另见 .cache 下的探针）。
// 注意: 本文件**只能**通过 openBank 触达引擎 —— 引擎在求值时读 process.env，
// 静态 import 任何 vendor/engine 模块都会让 env 在 openBank 之前定型（踩过）。

let dir: string
let bank: Awaited<ReturnType<typeof openBank>>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'castalia-bank-'))
  bank = await openBank({ bankDir: dir, project: 'testproj', charId: 'airi', allowNoConfig: true })
})

afterAll(() => {
  bank?.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('in-process bank', () => {
  it('writes and reads back a memory', async () => {
    const saved = await bank.save({
      text: '记忆体插件化：进程内跑引擎，不再走子进程或 HTTP。',
      project: 'testproj',
      memType: 'general',
      characterId: 'airi',
      skipEmbed: true,
    })
    expect(saved.id).toBeTruthy()

    const recent = bank.recent(5)
    expect(recent.length).toBeGreaterThan(0)
    expect(recent.some(r => String(r.text).includes('插件化'))).toBe(true)
  })

  it('keeps a diary day out of the memory list until the diary is searched', async () => {
    const saved = await bank.saveDiaryDay({
      date: '2026-11-06',
      description: 'He stayed up again.',
      body: 'watched two episodes at midnight.',
      characterId: 'airi',
    })
    expect(saved.name).toBe('diary-2026-11-06')

    // 页面、索引、默认检索都不该看到这一天
    expect(bank.listMemories(500).some(row => String(row.text ?? '').includes('diary-2026-11-06'))).toBe(false)
    const casual = await bank.search({ query: 'midnight', characterId: 'airi', topK: 5 })
    expect(Array.isArray(casual)).toBe(true)
    expect(casual.some(row => String(row.text ?? '').includes('midnight'))).toBe(false)

    // 明确翻日记才拿得到
    expect(bank.listDiaryDays({ characterId: 'airi' })[0]?.name).toBe('diary-2026-11-06')
    const found = await bank.searchDiary('midnight', { characterId: 'airi' })
    expect(found.some(row => String(row.text ?? '').includes('midnight'))).toBe(true)
    // 日记工具按这个头行解析一天：`# diary-YYYY-MM-DD`
    expect(String(found[0]?.text ?? '').startsWith('# diary-2026-11-06')).toBe(true)
  })

  it('keeps one active row when two windows remember the same day at once', async () => {
    // 实机：两个窗口同时「自己记一天」，各自的 SELECT 都看不到对方还没插的行，11-01 留下两条活行。
    const day = {
      date: '2026-11-07',
      description: 'Two windows wrote at once.',
      body: 'slept late again.',
      characterId: 'airi',
    }
    const [left, right] = await Promise.all([
      bank.saveDiaryDay(day),
      bank.saveDiaryDay({ ...day, description: 'Two windows wrote at once, second copy.' }),
    ])
    expect(left.name).toBe('diary-2026-11-07')
    expect(right.name).toBe('diary-2026-11-07')

    const active = bank.listDiaryDays({ characterId: 'airi' }).filter(row => row.name === 'diary-2026-11-07')
    expect(active).toHaveLength(1)
  })

  it('finds it back by lexical search', async () => {
    const hits = await bank.search({ query: '进程内跑引擎', project: 'testproj', characterId: 'airi', topK: 5, minScore: 0 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => String(h.text ?? '').includes('插件化'))).toBe(true)
  })

  it('tags VAD on the write path (no Ollama in-process)', async () => {
    // 进程内形态没有 autoProcess/digest 周期,所以 bank.save 自己补一次离线词表 VAD。
    // 这条测试盯的是"情感数据真的落库",不是词表精度。
    const saved = await bank.save({
      text: '她跟我说分手，我很难过',
      project: 'testproj',
      memType: 'general',
      characterId: 'airi',
      skipEmbed: true,
    })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const row = db.prepare('SELECT vad_valence, vad_arousal, emotional_impact FROM memory WHERE id = ?').get(saved.id) as any
    db.close()
    expect(row?.vad_valence).toBeLessThan(0)
    expect(Number(row?.emotional_impact)).toBeGreaterThan(0)
  })

  it('reconciles sessions: dry-run by default, soft-delete only anchored rows', async () => {
    // 写两条带 session 锚点的记忆 + 一条无锚点
    const a = await bank.save({ text: '会话 A 里的事', project: 'testproj', characterId: 'airi', sessionId: 'sess-a', skipEmbed: true })
    const b = await bank.save({ text: '会话 B 里的事', project: 'testproj', characterId: 'airi', sessionId: 'sess-b', skipEmbed: true })
    await bank.save({ text: '手写 lore,无会话锚点', project: 'testproj', characterId: 'airi', skipEmbed: true })

    const dry = bank.orphanSessions({ aliveSessionIds: ['sess-a'] })
    expect(dry.some(r => r.orphans > 0)).toBe(true)
    expect(dry.every(r => r.orphaned === 0)).toBe(true)   // 默认 dryRun

    const applied = bank.orphanSessions({ aliveSessionIds: ['sess-a'], dryRun: false })
    expect(applied.some(r => r.orphaned > 0)).toBe(true)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const rows = db.prepare('SELECT id, is_active FROM memory WHERE id IN (?,?)').all(a.id, b.id) as any[]
    db.close()
    const byId = new Map(rows.map(r => [r.id, Number(r.is_active)]))
    expect(byId.get(a.id)).toBe(1)   // 活会话不动
    expect(byId.get(b.id)).toBe(0)   // 孤儿被软删
  })

  it('runs the embedded self-cycle and keeps diary isolated', async () => {
    const turn = await bank.ingestTurn({ user: '我今天完成了一个重要任务', assistant: '我记住了这次进展。' })
    expect(turn.ok).toBe(true)
    const result = await bank.selfCycle({ minIntervalHours: 0, hoursBack: 48, limit: 6 })
    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(false)
    expect(result.diaryId).toBeTruthy()
    expect(result.evidenceIds).toContain(turn.id)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'project', 'memory.sqlite'))
    const diary = db.prepare('SELECT source, subject, metadata FROM memory WHERE id = ?').get(result.diaryId!) as any
    const metadata = JSON.parse(String(diary?.metadata || '{}'))
    db.close()
    const evidenceDb = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const evidence = evidenceDb.prepare('SELECT source FROM memory WHERE id = ?').get(turn.id!) as any
    evidenceDb.close()
    expect(diary?.source).toBe('agent_diary')
    expect(diary?.subject).toBe('self')
    expect(metadata.generated_by).toBe('self_cycle')
    expect(metadata.evidence_ids).toContain(turn.id)
    expect(evidence?.source).toBe('conversation_log')

    const again = await bank.selfCycle({ minIntervalHours: 0, hoursBack: 48, limit: 6 })
    expect(again.skipped).toBe(true)
    expect(again.reason).toBe('no_new_evidence')
  })

  it('reports stats through the same shim', () => {
    const stats = bank.stats()
    const general = stats.find(s => s.memType === 'general')
    expect(general?.active).toBeGreaterThan(0)
  })

  it('forgets and the row stops being active', async () => {
    const saved = await bank.save({
      text: '临时记忆：这条会被删掉。',
      project: 'testproj',
      memType: 'general',
      characterId: 'airi',
      skipEmbed: true,
    })
    bank.forget(saved.id)
    const still = bank.recent(20).some(r => r.id === saved.id)
    expect(still).toBe(false)
  })
})

describe('store tools (memory_store_* port)', () => {
  it('saves, lists, and forgets by index name', async () => {
    const saved = await bank.saveStore({
      name: 'test-entry',
      description: '一句话索引',
      body: '正文内容，用于验证 store 往返。',
      characterId: 'airi',
    })
    expect(saved.id).toBeTruthy()

    const listed = bank.listStore({ characterId: 'airi', source: 'airi' })
    const found = listed.records.find(r => r.name === 'test-entry')
    expect(found).toBeTruthy()
    expect(found?.description).toBe('一句话索引')
    expect(found?.body).toContain('正文内容')

    const again = await bank.saveStore({
      name: 'test-entry',
      description: '改过的索引',
      body: '改过的正文。',
      characterId: 'airi',
    })
    expect(again.updated).toBe(true)
    expect(again.id).toBe(saved.id)

    const forgotten = bank.forgetStore({ name: 'test-entry', characterId: 'airi' })
    expect(forgotten.deleted).toBe(true)
    const after = bank.listStore({ characterId: 'airi', source: 'airi' })
    expect(after.records.find(r => r.name === 'test-entry')).toBeUndefined()
  })

  it('writes one finished turn into conversation_log', async () => {
    // 这条盯的是"自回归结束后有话落库"：之前 app 里没有任何调用点，
    // airi 库的 conversation_log 自 2026-09-12 起再没增长过。
    const result = await bank.ingestTurn({ user: '你还记得我耳朵不太好使吗', assistant: '记得，我说话会慢一点。' })
    expect(result.ok).toBe(true)
    expect(result.id).toBeTruthy()
    expect(result.mode).toBe('minimal')

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const row = db.prepare(`SELECT text, source, is_active, type, category FROM memory WHERE id = ?`).get(result.id!) as any
    db.close()
    expect(row?.source).toBe('conversation_log')
    expect(row?.is_active).toBe(1)
    expect(row?.type).toBe('episodic')
    expect(row?.category).toBe('conversation')
    expect(row?.text).toContain('用户: 你还记得我耳朵不太好使吗')
    expect(row?.text).toContain('我说话会慢一点')
  })

  it('brings confirmed facts into the injection block', async () => {
    // facts 表以前完全不参与注入：76 条事实在库里躺着，用户问"我喜欢什么"照样答不上来。
    // 这里直接在库里造一条事实，再走注入路径确认它被带进上下文。
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO facts (id, subject, predicate, object, project, confidence, character_id, is_active, created_at, updated_at, valid_from)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run('fact-probe-1', 'user', '喜好', '月下漫步', 'testproj', 0.9, 'airi', now, now, now)
    db.close()

    // 引擎模块在求值时读 process.env，必须等 openBank 设好环境之后再动态 import
    const { recallFactsForQuery } = await import('../vendor/engine/factRecall')
    const hit = recallFactsForQuery('你还记得我喜欢什么吗', { project: 'testproj', characterId: 'airi' })
    expect(hit.facts.map((f: { object: string }) => f.object)).toContain('月下漫步')
    expect(hit.text).toContain('月下漫步')

    // 任务型问句不触发事实路（它是"关于人的稳定事实"，不是万能召回）
    const task = recallFactsForQuery('帮我写个快速排序', { project: 'testproj', characterId: 'airi' })
    expect(task.facts).toHaveLength(0)
  })

  it('answers a time question by date instead of by similarity', async () => {
    // 事件行有向量也排不进 top-12（人设长文分更高），所以带时间词时必须按日期直取。
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const today = new Date()
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO memory (id, text, project, type, category, tags, importance, character_id, source, subject, tier, is_active, created_at, updated_at, last_accessed_at, accessed_count, reference_count, mem_type)
                VALUES (?, ?, 'testproj', 'episodic', 'event', ?, 0.9, 'airi', 'daily_event', 'user', 'standard', 1, ?, ?, ?, 0, 0, 'general')`)
      .run('event-probe-1', `# ${day} · 今天加班到十点\n用户说今天加班到十点很累，她建议先洗个热水澡。`, JSON.stringify([`day:${day}`]), now, now, now)
    db.close()

    const { recallTemporalForQuery } = await import('../vendor/engine/temporalRecall')
    const hit = recallTemporalForQuery('我昨天在忙什么', { project: 'testproj', characterId: 'airi', limit: 5 })
    // 昨天没有事件，今天这条不该冒充"昨天"
    expect(hit.hits.map(h => h.day)).not.toContain('2026-01-01')

    const todayHit = recallTemporalForQuery('今天有什么要做的', { project: 'testproj', characterId: 'airi', limit: 5 })
    expect(todayHit.hits.some(h => h.title.includes('加班'))).toBe(true)
    expect(todayHit.text).toContain('按日期直取')

    // 没有时间词就不触发（任务类问句不该被塞进事件）
    expect(recallTemporalForQuery('帮我写个快速排序', { project: 'testproj' }).hits).toHaveLength(0)
  })

  it('does not count an injection as a recall', async () => {
    // 注入不算强化（nooa-memory 的口径）：注入路径以前照样 accessed_count+1、刷新
    // last_accessed_at，于是 被注入 → 排名更高 → 更常被注入，真实库里 lore 行滚到 200~306 次。
    // 这条盯的是"注入不记账、用户主动检索照常记账"这两半，缺一半都算坏。
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    await bank.ingestTurn({ user: '用户说他喜欢安安静静的月下散步', assistant: '记住了，月光好的时候我不吵你。' })
    const read = () => db.prepare(`SELECT id, accessed_count FROM memory`).all() as any[]
    const before = read()

    const recalled = await bank.recallQuery('用户喜欢安安静静的月下散步')
    const injected = (recalled.stats as any)?.ids ?? []
    const afterInjection = read()
    expect(injected.length).toBeGreaterThan(0)   // 没命中，下面的断言就是空转
    for (const row of afterInjection) {
      const old = before.find(b => b.id === row.id)!
      expect(row.accessed_count).toBe(old.accessed_count)
    }

    await bank.search({ query: '用户喜欢安安静静的月下散步', topK: 3, minScore: 0, profile: 'deep', includeGeneral: true })
    const afterSearch = read()
    db.close()
    expect(afterSearch.some(row => row.accessed_count > (before.find(b => b.id === row.id)?.accessed_count ?? 0))).toBe(true)
  })

  it('runs maintenance without a reflection model and reports what it did', async () => {
    // 维护长在 app 主进程里(这条链只有 app ↔ anima 两段)。这里用的是无 config 的临时库,
    // 所以反刍通道未配置 —— 正确行为不是抛错,而是如实报告"只跑了 digest"。
    const report = await bank.maintain({ limit: 5 })
    expect(report.reflectConfigured).toBe(false)
    expect(report.ok).toBe(true)
    expect(report.reflect?.ok).toBe(false)
    expect(report.digest?.success).toBe(true)
    expect(report.before).toBeTruthy()
    expect(report.after).toBeTruthy()
    expect(typeof report.ms).toBe('number')
  })

  it('refuses a turn with no text on either side', async () => {
    // 纯工具调用轮次可能不产出正文；写进去只会是半句残行。
    expect((await bank.ingestTurn({ user: '有话说', assistant: '   ' })).ok).toBe(false)
    expect((await bank.ingestTurn({ user: '', assistant: '有话答' })).ok).toBe(false)
  })

  it('refuses to hot-switch to another bank instead of silently reusing the first one', async () => {
    // 跨 bank 换库 = 用 A 的 config 去开 B 的库：alignEmbedSpace 会把 B 的向量索引清掉。
    // 旧行为是继续返回同一个引擎句柄（写入落回 A），比抛错更难查。
    const other = mkdtempSync(join(tmpdir(), 'castalia-bank-other-'))
    await expect(openBank({ bankDir: other, project: 'testproj', charId: 'airi', allowNoConfig: true }))
      .rejects.toThrow(/不能热切换 bank/)
    try { rmSync(other, { recursive: true, force: true }) } catch {}
  })
})

describe('explicit emotion reaches the engine psyche', () => {
  // ROOT CAUSE: recordEmotion wrote the prompt and the panel only. The engine kept its own psyche,
  // so the panel could say the tone moved while the state machine stayed still.
  it('moves the psyche and reports the version it landed on', async () => {
    const before = await bank.psycheState()
    const result = await bank.applyEmotion({
      vad: { valence: 0.9, arousal: 0.1, dominance: 0.2 },
      reason: 'she shared good news',
      at: Date.now(),
    })

    expect(result.reason).toBe('applied')
    expect(result.applied).toBe(true)
    expect(result.version).toBeGreaterThan(before.version)
    expect((await bank.psycheState()).version).toBe(result.version)
  })

  it('applies one turn once, even when the same turn is retried', async () => {
    const at = Date.now()
    const first = await bank.applyEmotion({ vad: { valence: -0.9, arousal: 0.6, dominance: -0.4 }, at, eventId: 'turn-42' })
    const second = await bank.applyEmotion({ vad: { valence: -0.9, arousal: 0.6, dominance: -0.4 }, at, eventId: 'turn-42' })

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(second.version).toBe(first.version)
  })

  // 冻结的负性倍率必须落库：每次应用事件都优先读数据库状态，内存里冻结、库里没有，
  // 「落库后读一次」的轨迹就会偏离内存轨迹。
  it('persists the frozen negative bias so a reread keeps the same trajectory', async () => {
    await bank.applyEmotion({ vad: { valence: -0.9, arousal: 0.5, dominance: -0.2 }, at: Date.now(), eventId: 'turn-bias' })

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const row = db.prepare('SELECT valence_bias FROM psyche_state WHERE character_id = ?').get('airi') as any
    db.close()

    expect(Number(row?.valence_bias)).toBeGreaterThanOrEqual(1)
    const snapshot = await bank.psycheState()
    expect(snapshot.version).toBeGreaterThan(0)
  })

  it('refuses a reading with no affect in it', async () => {
    const result = await bank.applyEmotion({ vad: { valence: 0.01, arousal: 0.02, dominance: 0.03 } })
    expect(result.reason).toBe('neutral')
    expect(result.applied).toBe(false)
  })
})

describe('pending VAD rows survive a restart', () => {
  // ROOT CAUSE: the in-memory queue is rebuilt only by the nightly digest, and only for its own
  // character. A row left pending by a previous process, or by a character nobody opens any more,
  // waited forever (live bank: 8 rows from 03:18 the same night, still pending 33 h later).
  it('flushes a row the live queue never saw, under another character', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const file = join(dir, 'testproj', 'general', 'memory.sqlite')
    const text = '用户: 旧进程留下的一句\n助手: 我还在。'
    const at = new Date().toISOString()
    const db = new DatabaseSync(file)
    db.prepare(`INSERT INTO memory (id, text, project, character_id, source, is_active, affect_status, affect_source, created_at, updated_at)
      VALUES (?, ?, 'testproj', 'left-behind', 'conversation_log', 1, 'pending', 'vad_queue', ?, ?)`)
      .run('left-behind-row', text, at, at)
    db.close()

    const result = await bank.flushStaleVadQueue(0)
    expect(result.updated).toBeGreaterThan(0)

    const check = new DatabaseSync(file)
    const row = check.prepare('SELECT affect_status FROM memory WHERE id = ?').get('left-behind-row') as { affect_status?: string } | undefined
    check.close()

    expect(row?.affect_status).not.toBe('pending')
  })
})

describe('a turn the model already judged', () => {
  // ROOT CAUSE: the explicit write and the VAD sweep both appraised the same turn, so one switch
  // refused the explicit write and the other made it optional. The verdict now travels with the
  // turn: the row lands analyzed and never enters the queue.
  it('stores the verdict on the row and keeps it out of the VAD queue', async () => {
    const result = await bank.ingestTurn({
      user: '今天有点累',
      assistant: '那就早点睡。',
      affect: { vad: { valence: 0.4, arousal: 0.2, dominance: 0.1 }, reason: '心疼' },
    })
    expect(result.ok).toBe(true)
    const id = String(result.id)

    const { DatabaseSync } = await import('node:sqlite')
    const file = join(dir, 'testproj', 'general', 'memory.sqlite')
    const db = new DatabaseSync(file)
    const row = db.prepare('SELECT affect_status, affect_source, vad_valence, affect_analyzed_at FROM memory WHERE id = ?').get(id) as { affect_status?: string, affect_source?: string, vad_valence?: number, affect_analyzed_at?: string } | undefined
    db.close()

    expect(row?.affect_status).toBe('analyzed')
    expect(row?.affect_source).toBe('model')
    expect(Number(row?.vad_valence)).toBeCloseTo(0.4)

    await bank.flushStaleVadQueue(0)
    const after = new DatabaseSync(file)
    const kept = after.prepare('SELECT affect_status, affect_analyzed_at FROM memory WHERE id = ?').get(id) as { affect_status?: string, affect_analyzed_at?: string } | undefined
    after.close()
    expect(kept?.affect_status).toBe('analyzed')
    expect(kept?.affect_analyzed_at).toBe(row?.affect_analyzed_at)
  })
})
