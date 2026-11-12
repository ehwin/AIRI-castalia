import { describe, expect, it } from 'vitest'

import { pushRecentIds, RECENT_ID_LIMIT, recentIdsFor } from './recent-ids'

describe('recent recall ids', () => {
  it('keeps one list per character', () => {
    const store = new Map<string, string[]>()

    pushRecentIds(store, 'airi', ['a1', 'a2'])
    pushRecentIds(store, 'N_card', ['b1'])

    expect(recentIdsFor(store, 'airi')).toEqual(['a1', 'a2'])
    expect(recentIdsFor(store, 'N_card')).toEqual(['b1'])
  })

  it('does not let one character suppress the other', () => {
    // 共享记忆两张卡都能看见：第一张卡刚读过的 id 不能把第二张卡的那一行也排掉。
    const store = new Map<string, string[]>()

    pushRecentIds(store, 'airi', ['general-1'])

    expect(recentIdsFor(store, 'N_card')).toEqual([])
  })

  it('caps the list and keeps the newest ids', () => {
    const store = new Map<string, string[]>()
    pushRecentIds(store, 'airi', Array.from({ length: 8 }, (_, index) => `old-${index}`))

    pushRecentIds(store, 'airi', ['new-1', 'new-2', 'new-3', 'new-4'])

    const kept = recentIdsFor(store, 'airi')
    expect(kept).toHaveLength(RECENT_ID_LIMIT)
    expect(kept.at(-1)).toBe('new-4')
    expect(kept).not.toContain('old-0')
  })

  it('drops junk ids instead of spending a slot on them', () => {
    const store = new Map<string, string[]>()

    pushRecentIds(store, 'airi', ['ok', undefined, '', 42, null])

    expect(recentIdsFor(store, 'airi')).toEqual(['ok'])
  })

  it('treats a missing character as the default one', () => {
    const store = new Map<string, string[]>()

    pushRecentIds(store, undefined, ['x'])
    pushRecentIds(store, '  ', ['y'])

    expect(recentIdsFor(store, 'default')).toEqual(['x', 'y'])
  })
})
