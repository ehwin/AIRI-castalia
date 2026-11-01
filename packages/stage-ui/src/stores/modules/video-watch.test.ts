// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useVideoWatchStore } from './video-watch'

describe('video watch queue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('queues a clip once, keeping the older entry', () => {
    const store = useVideoWatchStore()
    const first = store.enqueue({ source: 'BV1a5sZ6LEN3', why: '她讲的分镜方案值得看' })
    const again = store.enqueue({ source: 'BV1a5sZ6LEN3', why: '再说一次' })

    expect(store.pending).toHaveLength(1)
    expect(again?.id).toBe(first?.id)
    expect(store.pending[0]!.why).toBe('她讲的分镜方案值得看')
  })

  it('keeps the oldest item first, so the one that waited is picked', () => {
    const store = useVideoWatchStore()
    store.enqueue({ source: 'BV1', why: 'a' })
    store.enqueue({ source: 'BV2', why: 'b' })
    // The queue sorts by addedAt; both were added in the same millisecond, so pin the order.
    store.items[0]!.addedAt = 1
    store.items[1]!.addedAt = 2
    expect(store.pending.map(item => item.source)).toEqual(['BV1', 'BV2'])
  })

  it('marks what she watched with her note and counts it for today', () => {
    const store = useVideoWatchStore()
    const item = store.enqueue({ source: 'BV1', why: 'a' })!
    store.markWatched(item.id, '前 40 条字幕，关键时间点 00:10 01:20')

    expect(store.pending).toHaveLength(0)
    expect(store.watched[0]).toMatchObject({ state: 'watched', note: '前 40 条字幕，关键时间点 00:10 01:20' })
    expect(store.watchedToday()).toBe(1)
    expect(store.lastWatchedAt).toBeTypeOf('number')
  })

  it('answers a recall with the note and the reason she queued it', () => {
    const store = useVideoWatchStore()
    const item = store.enqueue({ source: 'BV1', why: '因为好奇' })!
    store.markWatched(item.id, '只出了一张分镜，没有台词轨')

    const recall = store.recall(3)
    expect(recall).toContain('BV1')
    expect(recall).toContain('因为好奇')
    expect(recall).toContain('没有台词轨')
  })

  it('says so when she never watched anything', () => {
    expect(useVideoWatchStore().recall()).toContain('not watched anything')
  })

  it('caps the queue instead of hoarding, dropping the oldest pending item', () => {
    const store = useVideoWatchStore()
    for (let index = 0; index < 25; index++)
      store.enqueue({ source: `BV${index}`, why: 'x' })

    expect(store.pending).toHaveLength(20)
    expect(store.pending.some(item => item.source === 'BV0')).toBe(false)
    expect(store.pending.some(item => item.source === 'BV24')).toBe(true)
  })

  it('reports how long the head of the queue has waited', () => {
    const store = useVideoWatchStore()
    const item = store.enqueue({ source: 'BV1', why: 'a' })!
    store.items[0]!.addedAt = Date.now() - 90 * 60_000
    expect(store.oldestPendingAgeMs()).toBeGreaterThanOrEqual(89 * 60_000)
    expect(item.id).toBe(store.items[0]!.id)
  })
})
