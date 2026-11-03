import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCastaliaPluginStore } from './store'

describe('castalia plugin state', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.useRealTimers())

  it('decays VAD and keeps each character state isolated', () => {
    const store = useCastaliaPluginStore()
    store.setTsundereLevel(8, 'airi')
    store.recordEmotion({ valence: 0.8, arousal: 0.4, dominance: 0.2 }, 'I enjoyed the exchange.', 'airi')
    store.setDesire('Keep exploring.', 'airi')
    store.recordMood(-4, 'A separate character state.', 'other')

    const airi = store.snapshotFor('airi')
    const other = store.snapshotFor('other')

    expect(airi.currentMood).toBe(8)
    expect(airi.currentDesire).toBe('Keep exploring.')
    expect(airi.tsundereLevel).toBe(8)
    expect(airi.vad?.valence).toBeCloseTo(0.8)
    expect(other.currentMood).toBe(-4)
    expect(other.currentDesire).toBeNull()
    expect(other.vad).toBeUndefined()
  })

  it('starts an unrecorded character at full energy', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
    const store = useCastaliaPluginStore()
    store.setCharacter('never-recorded')
    // An empty state built once at import would carry the import timestamp and
    // decay here. A state built per read starts from the clock of that read.
    vi.setSystemTime(new Date('2026-11-26T00:00:00Z'))

    expect(store.currentEnergy).toBe(100)
    expect(store.snapshotFor('never-recorded').energy).toBe(100)
  })

  it('mirrors the mind\'s fatigue without decaying it back', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
    const store = useCastaliaPluginStore()
    store.setEnergy(25, 'airi')

    expect(store.snapshotFor('airi').energy).toBe(25)

    vi.setSystemTime(new Date('2026-11-02T00:01:00Z'))
    expect(store.snapshotFor('airi').energy).toBe(25)
  })

  it('does not refund energy when the psyche mirror syncs', () => {
    vi.useFakeTimers()
    const start = new Date('2026-11-02T00:00:00Z').getTime()
    vi.setSystemTime(start)
    const store = useCastaliaPluginStore()
    store.setEnergy(40, 'airi')

    // Six hours of the five-minute mirror. Before this, every sync moved
    // `lastUpdated` without settling the gauge, so the debt was forgiven.
    for (let i = 1; i <= 72; i++) {
      const at = start + i * 5 * 60_000
      vi.setSystemTime(at)
      store.syncPsyche({ vad: { valence: 0, arousal: 0, dominance: 0 }, at }, 'airi')
    }

    expect(store.snapshotFor('airi').energy).toBeLessThan(40)
    expect(store.snapshotFor('airi').energy).toBeGreaterThan(20)
  })
})
