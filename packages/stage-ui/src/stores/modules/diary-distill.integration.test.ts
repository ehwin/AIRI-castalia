import type { Thought } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from '../memory'
import { useDiaryStore } from './diary'
import { useMindStore } from './mind'

/**
 * 日记是否真的接进了逻辑：思绪 → 日记 → 「记住这一天」 → 日记分区。
 *
 * 这几段各自有实现，但没有一处测试把它们串起来，而线上真库里已经出现过
 * 32 条描述为空的日记记忆和同一晚 7 条近似条目。
 *
 * 分区边界一起守住：记住的一天只进日记，不进长期记忆列表，也不进提示词索引。
 */
const thoughts: Thought[] = [
  { id: 't1', at: new Date('2026-11-01T09:12:00').getTime(), text: 'noticed: 阅读Gemini学习建议', visibility: 'private', topic: 'self-cycle' } as Thought,
  { id: 't2', at: new Date('2026-11-01T13:40:00').getTime(), text: 'noticed: 运行AI代码调试任务', visibility: 'private', topic: 'self-cycle' } as Thought,
  { id: 't3', at: new Date('2026-11-01T19:30:00').getTime(), text: '他说今天累死了，我记着了', visibility: 'shared', topic: 'self-cycle' } as Thought,
]

vi.mock('../../database/repos/inner-thoughts.repo', () => ({
  innerThoughtsRepo: {
    readAll: vi.fn(async () => thoughts),
    append: vi.fn(),
    readLastSeenAt: vi.fn(async () => undefined),
    saveLastSeenAt: vi.fn(),
    clear: vi.fn(),
  },
}))

/** What the diary page hands the bank for one day. */
interface DiaryDayInput {
  date: string
  description: string
  body: string
  persona?: string
}

/** A port with a diary: the ordinary entry list stays empty, the diary call is what records a day. */
function attachDiaryPort(rememberDay: (day: DiaryDayInput) => Promise<{ ok: boolean, reason?: string }>) {
  const memory = useMemoryStore()
  const save = vi.fn(async () => {})
  const list = vi.fn(async () => [])
  memory.attachRemote({
    list,
    save,
    forget: async () => true,
    rememberDay,
    searchDiary: async () => [],
  })
  return { memory, save, list }
}

describe('diary → memory', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('reads the day from the thought stream and groups it by date', async () => {
    const diary = useDiaryStore()
    await diary.load()

    expect(diary.byDay).toHaveLength(1)
    expect(diary.byDay[0].date).toBe('2026-11-01')
    expect(diary.byDay[0].thoughts).toHaveLength(3)
    // 默认不外露：隐私条数要算出来，正文不给
    expect(diary.byDay[0].privateCount).toBe(2)
    expect(diary.shared).toHaveLength(1)
  })

  it('remembers a day in the diary partition, not in the index', async () => {
    const rememberDay = vi.fn(async (_day: DiaryDayInput) => ({ ok: true }))
    const { memory, save } = attachDiaryPort(rememberDay)
    const diary = useDiaryStore()
    await diary.load()

    const entry = await diary.distill('2026-11-01')
    expect(entry?.name).toBe('diary-2026-11-01')

    // Ask for the persona the diary actually writes to; the alias `default` -> `airi` only holds
    // while `airi` owns rows, and a fresh store has none.
    const persona = memory.resolvePersona(useMindStore().scope)
    expect(rememberDay).toHaveBeenCalledTimes(1)
    const [day] = rememberDay.mock.calls[0]!
    expect(day.date).toBe('2026-11-01')
    // 她说出口的那句优先被选中
    expect(day.description).toContain('我记着了')
    // 原始行留在 body 里
    expect(day.body).toContain('运行AI代码调试任务')
    expect(day.persona).toBe(persona)

    // 日记只进分区：不进长期记忆列表，不走普通保存，也不进提示词索引。
    expect(memory.entries).toHaveLength(0)
    expect(save).not.toHaveBeenCalled()
    expect(memory.indexFor(persona)).not.toContain('2026-11-01')
  })

  it('keeps one day when the same day is remembered twice', async () => {
    const rememberDay = vi.fn(async (_day: DiaryDayInput) => ({ ok: true }))
    const { memory } = attachDiaryPort(rememberDay)
    const diary = useDiaryStore()
    await diary.load()

    await diary.distill('2026-11-01')
    await diary.distill('2026-11-01')

    // 同名替换发生在银行侧（软删旧行再插），页面这一层只负责把这一天记下来。
    expect(rememberDay).toHaveBeenCalledTimes(2)
    expect(memory.entries).toHaveLength(0)
    // 按钮要能说"已记住"，否则刷新后又劝你把同一天再记一遍
    expect(diary.hasDistilled('2026-11-01')).toBe(true)
    expect(diary.hasDistilled('2026-10-31')).toBe(false)
  })

  it('keeps nothing when the memory module is off', async () => {
    const rememberDay = vi.fn(async (_day: DiaryDayInput) => ({ ok: true }))
    const { memory } = attachDiaryPort(rememberDay)
    const diary = useDiaryStore()
    await diary.load()
    memory.enabled = false

    const entry = await diary.distill('2026-11-01')

    expect(entry).toBeUndefined()
    expect(rememberDay).not.toHaveBeenCalled()
    expect(diary.hasDistilled('2026-11-01')).toBe(false)
  })

  it('does not mark the day when the bank refuses the write', async () => {
    // ROOT CAUSE: distill() checked the optimistic entry, not the persisted result. The day flipped
    // to "已记住" while the bank rolled the row back, and nothing retried it.
    const rememberDay = vi.fn(async (_day: DiaryDayInput) => ({ ok: false, reason: 'backend down' }))
    const { memory } = attachDiaryPort(rememberDay)
    const diary = useDiaryStore()
    await diary.load()

    const entry = await diary.distill('2026-11-01')

    expect(entry).toBeUndefined()
    expect(rememberDay).toHaveBeenCalledTimes(1)
    expect(diary.hasDistilled('2026-11-01')).toBe(false)
    expect(memory.entries).toHaveLength(0)
  })

  it('keeps persona-less thoughts with the card that read them', async () => {
    // ROOT CAUSE: `load()` filtered `!thought.persona` for every card, so a thought written
    // before the per-card split showed up in every character's diary.
    const mind = useMindStore()
    const diary = useDiaryStore()
    await diary.load()
    expect(diary.thoughts).toHaveLength(3)

    await mind.switchCharacter('another-card')
    await diary.load()
    expect(diary.thoughts).toHaveLength(0)
  })

  it('says nothing when the day holds no usable line', async () => {
    const diary = useDiaryStore()
    await diary.load()

    expect(await diary.distill('2026-10-01')).toBeUndefined()
  })
})
