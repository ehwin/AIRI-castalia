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

  // 查询在途时她又记了一条情绪，晚到的旧快照不能把新的盖掉、也不能把时间戳带回去。
  it('ignores a snapshot older than the emotion already recorded', () => {
    const store = useCastaliaPluginStore()
    store.syncPsyche({ vad: { valence: 0.7, arousal: 0.2, dominance: 0.1 }, band: 'positive', at: 2000 }, 'airi')
    store.syncPsyche({ vad: { valence: -0.6, arousal: 0.5, dominance: -0.3 }, band: 'negative', at: 1000 }, 'airi')

    const airi = store.snapshotFor('airi')
    expect(airi.vad?.valence).toBeCloseTo(0.7)
    expect(airi.band).toBe('positive')
  })

  // 引擎判定证据过期后，镜像不能再展示旧情绪；愿望、精力和显式情绪记录是她的，不该一起清掉。
  it('drops the mirrored psyche when the engine says the evidence expired', () => {
    const store = useCastaliaPluginStore()
    // recordEmotion 用的是墙钟，后续快照必须比它更新，否则会被「拒绝旧答案」先挡掉。
    const now = Date.now()
    store.recordEmotion({ valence: -0.4, arousal: 0.3, dominance: -0.2 }, 'A bad day.', 'airi')
    store.setDesire('Get some rest.', 'airi')
    store.syncPsyche({ vad: { valence: 0.5, arousal: 0.1, dominance: 0.2 }, band: 'positive', at: now + 1000 }, 'airi')

    store.syncPsyche({ at: now + 2000, hasEvidence: false }, 'airi')

    const airi = store.snapshotFor('airi')
    expect(airi.vad).toBeUndefined()
    expect(airi.band).toBeUndefined()
    expect(airi.currentDesire).toBe('Get some rest.')
    expect(airi.moodHistory.every(event => event.reason !== 'psyche')).toBe(true)
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

  it('clears an expired psyche mirror and keeps explicit mood events', () => {
    const store = useCastaliaPluginStore()
    store.recordEmotion({ valence: -0.8, arousal: 0.6, dominance: -0.2 }, 'A direct emotion.', 'airi')
    store.syncPsyche({
      hasEvidence: true,
      vad: { valence: -0.7, arousal: 0.5, dominance: -0.1 },
      mood: { valence: 0.1, arousal: 0.1, dominance: 0.2 },
      band: 'negative',
    }, 'airi')
    store.syncPsyche({
      hasEvidence: false,
      vad: { valence: 0.4, arousal: 0.3, dominance: 0.6 },
      mood: { valence: 0.4, arousal: 0.3, dominance: 0.6 },
      band: 'neutral',
    }, 'airi')

    const snapshot = store.snapshotFor('airi')

    expect(snapshot.vad).toBeUndefined()
    expect(snapshot.mood).toBeUndefined()
    expect(snapshot.band).toBeUndefined()
    expect(snapshot.moodHistory.some(event => event.reason === 'psyche')).toBe(false)
    expect(snapshot.moodHistory.some(event => event.reason === 'A direct emotion.')).toBe(true)
  })

  it('ignores an older psyche response after a newer emotion', () => {
    vi.useFakeTimers()
    const now = Date.UTC(2026, 10, 5)
    vi.setSystemTime(now)
    const store = useCastaliaPluginStore()
    const vad = { valence: -0.8, arousal: 0.6, dominance: -0.2 }
    store.recordEmotion(vad, 'A new emotion.', 'airi')

    for (const hasEvidence of [true, false]) {
      store.syncPsyche({
        hasEvidence,
        vad: { valence: 0.4, arousal: 0.3, dominance: 0.6 },
        at: now - 1000,
      }, 'airi')

      expect(store.snapshotFor('airi').vad).toEqual(vad)
      expect(store.snapshotFor('airi').moodHistory).toHaveLength(1)
    }
  })
})
