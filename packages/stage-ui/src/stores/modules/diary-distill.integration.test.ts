import type { Thought } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDiaryStore } from './diary'
import { useMemoryStore } from '../memory'

/**
 * 日记是否真的接进了逻辑：思绪 → 日记 → 「记住这一天」 → 长期记忆索引。
 *
 * 这几段各自有实现，但没有一处测试把它们串起来，而线上真库里已经出现过
 * 32 条描述为空的日记记忆和同一晚 7 条近似条目。
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

  it('turns a day into exactly one index line', async () => {
    const diary = useDiaryStore()
    const memory = useMemoryStore()
    await diary.load()

    const entry = diary.distill('2026-11-01')
    expect(entry?.name).toBe('diary-2026-11-01')

    const index = memory.indexFor('airi')
    const lines = index.split('\n').filter(line => line.startsWith('- '))

    // 一天一条，且要能通过新的索引过滤（转储/空描述/每天上限）
    expect(lines.filter(line => line.includes('diary-2026-11-01'))).toHaveLength(1)
    // 她说出口的那句优先被选中
    expect(index).toContain('我记着了')
    // 原始行留在 body 里，不进索引
    expect(lines.some(line => line.includes('noticed: 运行AI代码调试任务'))).toBe(false)
  })

  it('does not add a second entry when the same day is remembered twice', async () => {
    const diary = useDiaryStore()
    const memory = useMemoryStore()
    await diary.load()

    diary.distill('2026-11-01')
    const afterFirst = memory.entries.length
    diary.distill('2026-11-01')

    expect(memory.entries).toHaveLength(afterFirst)
    expect(memory.indexFor('airi').split('\n').filter(line => line.includes('diary-2026-11-01'))).toHaveLength(1)
    // 按钮要能说"已记住"，否则刷新后又劝你把同一天再记一遍
    expect(diary.hasDistilled('2026-11-01')).toBe(true)
    expect(diary.hasDistilled('2026-10-31')).toBe(false)
  })

  it('says nothing when the day holds no usable line', async () => {
    const diary = useDiaryStore()
    await diary.load()

    expect(diary.distill('2026-10-01')).toBeUndefined()
  })
})
