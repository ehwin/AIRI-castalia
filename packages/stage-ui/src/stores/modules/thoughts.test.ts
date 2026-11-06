import type { Thought } from '@proj-airi/core-agent'

import type { MemoryThoughtInput } from '../memory'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from '../memory'
import { useThoughtsStore } from './thoughts'

/**
 * 念头存档：本地流 → 记忆体的 thoughts 分区。
 *
 * 这不是召回链路（没有向量、不进索引），所以这里守的是三件事：
 * 只补银行没有的那一段、失败不能静默跳过、打不开时页面要说打不开。
 */
const stream = vi.hoisted(() => ({ current: [] as Thought[] }))

vi.mock('../../database/repos/inner-thoughts.repo', () => ({
  innerThoughtsRepo: {
    readAll: vi.fn(async (limit = 200) => stream.current.slice(-limit)),
    append: vi.fn(),
    readLastSeenAt: vi.fn(async () => undefined),
    saveLastSeenAt: vi.fn(),
    clear: vi.fn(),
  },
}))

function thought(id: string, at: number, text = `noticed: ${id}`): Thought {
  return { id, at, text, visibility: 'private', topic: 'self-cycle' } as Thought
}

describe('thought archive', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stream.current = []
  })

  it('archives only the lines the bank does not have yet', async () => {
    const memory = useMemoryStore()
    const rememberThoughts = vi.fn(async (rows: MemoryThoughtInput[]) => ({ ok: true, saved: rows.length }))
    const listThoughts = vi.fn(async () => ([{ id: 'old', at: 1_000, text: 'noticed: old', visibility: 'private' }]))
    memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => true, rememberThoughts, listThoughts })

    stream.current = [thought('old', 1_000), thought('new', 2_000)]
    const archive = useThoughtsStore()

    expect(await archive.archive()).toBe(1)
    expect(rememberThoughts).toHaveBeenCalledTimes(1)
    expect(rememberThoughts.mock.calls[0]![0].map(row => row.id)).toEqual(['new'])

    // 游标记住了：再跑一次不会重复上传
    expect(await archive.archive()).toBe(0)
    expect(rememberThoughts).toHaveBeenCalledTimes(1)
  })

  it('sends the line again once she says it out loud', async () => {
    // 游标只会向前：一条念头先以 private 存档，之后被她说出口（visibility 变 shared），
    // 不补这一次，存档里就永远停在她没说过的版本，那一页看不到她自己说出来的话。
    const memory = useMemoryStore()
    const rememberThoughts = vi.fn(async (rows: MemoryThoughtInput[]) => ({ ok: true, saved: rows.length }))
    const listThoughts = vi.fn(async () => ([{ id: 'a', at: 1_000, text: 'noticed: a', visibility: 'private' }]))
    memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => true, rememberThoughts, listThoughts })

    stream.current = [thought('a', 1_000)]
    const archive = useThoughtsStore()
    expect(await archive.archive()).toBe(0)
    expect(rememberThoughts).not.toHaveBeenCalled()

    stream.current = [{ ...thought('a', 1_000), visibility: 'shared' } as Thought]
    expect(await archive.archive()).toBe(1)
    expect(rememberThoughts.mock.calls[0]![0][0]!.visibility).toBe('shared')

    // 送过一次就不再重复
    expect(await archive.archive()).toBe(0)
  })

  it('keeps the cursor when the bank refuses, so the next flush retries', async () => {
    const memory = useMemoryStore()
    const rememberThoughts = vi.fn(async () => ({ ok: false, reason: 'bank down' }))
    memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => true, rememberThoughts, listThoughts: async () => [] })

    stream.current = [thought('a', 1_000)]
    const archive = useThoughtsStore()

    expect(await archive.archive()).toBe(0)
    // 游标没前进，第二次还会再送同一行
    expect(await archive.archive()).toBe(0)
    expect(rememberThoughts).toHaveBeenCalledTimes(2)
  })

  it('says the archive could not be opened instead of showing it empty', async () => {
    const memory = useMemoryStore()
    memory.attachRemote({
      list: async () => [],
      save: async () => {},
      forget: async () => true,
      rememberThoughts: async () => ({ ok: true, saved: 0 }),
      listThoughts: async () => { throw new Error('bank unreachable') },
    })

    const archive = useThoughtsStore()
    await archive.load()

    expect(archive.error).toContain('bank unreachable')
    expect(archive.thoughts).toHaveLength(0)
  })

  it('groups the archive by local day', async () => {
    const memory = useMemoryStore()
    memory.attachRemote({
      list: async () => [],
      save: async () => {},
      forget: async () => true,
      rememberThoughts: async () => ({ ok: true, saved: 0 }),
      listThoughts: async () => ([
        { id: '1', at: new Date('2026-11-05T10:00:00').getTime(), text: 'a', visibility: 'private' },
        { id: '2', at: new Date('2026-11-05T22:00:00').getTime(), text: 'b', visibility: 'shared' },
        { id: '3', at: new Date('2026-11-06T08:00:00').getTime(), text: 'c', visibility: 'private' },
      ]),
    })

    const archive = useThoughtsStore()
    await archive.load()

    expect(archive.byDay.map(day => day.date)).toEqual(['2026-11-06', '2026-11-05'])
    expect(archive.byDay[1]!.thoughts).toHaveLength(2)
    expect(archive.byDay[1]!.privateCount).toBe(1)
  })
})
