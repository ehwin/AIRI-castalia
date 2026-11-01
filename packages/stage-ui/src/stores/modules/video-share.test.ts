// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the three stores that receive the answer are mocked: creating them for real needs a running
// engine, and what this file is about is the card bookkeeping, not the engine.
const recordMood = vi.fn()
const memoryWrite = vi.fn()

vi.mock('@proj-airi/castalia-plugin', () => ({
  useCastaliaPluginStore: () => ({ recordMood }),
}))
vi.mock('../memory', () => ({ useMemoryStore: () => ({ write: memoryWrite }) }))
vi.mock('./airi-card', () => ({ useAiriCardStore: () => ({ activeCardId: 'default' }) }))

const { feedbackEffect, useVideoShareStore } = await import('./video-share')

const note = '大肥鱼怎么知道第37分钟发生了什么？（05:49）\n\n没有台词轨，只看了一张分镜（16 格），关键时间点: 00:00 00:13'

describe('video share panel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    recordMood.mockClear()
    memoryWrite.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('publishes a card with her own line and the digest', () => {
    const store = useVideoShareStore()
    const card = store.publish({ source: 'BV1a5sZ6LEN3', headline: '这段分镜讲得比我清楚', why: '好奇', note })

    expect(card).toBeDefined()
    expect(store.pendingCount).toBe(1)
    expect(store.list[0]).toMatchObject({ source: 'BV1a5sZ6LEN3', status: 'draft', headline: '这段分镜讲得比我清楚' })
  })

  it('refuses a card with nothing to show', () => {
    expect(useVideoShareStore().publish({ source: 'BV1', headline: 'h', why: 'w', note: '   ' })).toBeUndefined()
  })

  it('replaces the same clip within a day instead of stacking it', () => {
    const store = useVideoShareStore()
    store.publish({ source: 'BV1', headline: 'first', why: 'w', note })
    const second = store.publish({ source: 'BV1', headline: 'again', why: 'w', note })

    expect(store.list).toHaveLength(1)
    expect(second?.headline).toBe('again')
  })

  it('records a tap without touching her mood itself', () => {
    // The panel can live in a window where the engine is not connected: it must only record.
    const store = useVideoShareStore()
    const card = store.publish({ source: 'BV1', headline: 'h', why: 'w', note })!

    const answered = store.react(card.id, 'wants')

    expect(answered).toMatchObject({ status: 'seen', reaction: 'wants', applied: false })
    expect(store.pendingCount).toBe(0)
    expect(store.unapplied.map(entry => entry.id)).toEqual([card.id])
    expect(recordMood).not.toHaveBeenCalled()
    expect(memoryWrite).not.toHaveBeenCalled()
  })

  it('answers once: a second tap does not overwrite the first', () => {
    const store = useVideoShareStore()
    const card = store.publish({ source: 'BV1', headline: 'h', why: 'w', note })!
    store.react(card.id, 'wants')

    expect(store.react(card.id, 'pass')).toBeUndefined()
    expect(store.list[0]!.reaction).toBe('wants')
  })

  it('delivers an answer to her mood and memory exactly once', () => {
    const store = useVideoShareStore()
    const card = store.publish({ source: 'BV1', headline: 'h', why: 'w', note })!
    store.react(card.id, 'wants')

    store.applyPending()
    store.applyPending()

    expect(recordMood).toHaveBeenCalledTimes(1)
    expect(recordMood).toHaveBeenCalledWith(2, '主人点开了我分享的视频')
    expect(memoryWrite).toHaveBeenCalledTimes(1)
    expect(store.unapplied).toHaveLength(0)
    expect(store.list[0]!.applied).toBe(true)
  })

  it('leaves the answer pending when the write fails, so the next tick retries', () => {
    const store = useVideoShareStore()
    const card = store.publish({ source: 'BV1', headline: 'h', why: 'w', note })!
    store.react(card.id, 'more')
    recordMood.mockImplementationOnce(() => {
      throw new Error('engine offline')
    })

    store.applyPending()

    expect(store.unapplied).toHaveLength(1)
    expect(store.list[0]!.applied).toBeFalsy()
  })

  it('maps each answer to the consequence she feels', () => {
    expect(feedbackEffect('wants')).toEqual({ mood: 2, reason: '主人点开了我分享的视频' })
    expect(feedbackEffect('more')).toEqual({ mood: 1, reason: '主人想听我多讲一点' })
    expect(feedbackEffect('pass')).toEqual({ mood: -1, reason: '主人对我分享的东西没兴趣' })
  })

  it('keeps a panel headline short enough to read', () => {
    const store = useVideoShareStore()
    expect(store.headlineFor('x'.repeat(300)).length).toBeLessThanOrEqual(120)
  })
})
