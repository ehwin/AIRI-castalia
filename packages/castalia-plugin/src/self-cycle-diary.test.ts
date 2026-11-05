import { describe, expect, it } from 'vitest'

import { formatDiary } from './vendor/engine/selfCycle'

describe('self-cycle diary state line', () => {
  it('uses the sensor mood when it has evidence, not the legacy scalar', () => {
    const state = { currentMood: 8, energy: 98, currentDesire: null } as any
    const psyche = {
      hasEvidence: true,
      band: 'neutral',
      vad: { valence: 0.29, arousal: 0.16, dominance: -0.07 },
    } as any

    const text = formatDiary(state, psyche, [], 42)

    // The legacy +8 would contradict "neutral"; one entry, one mood.
    expect(text).toContain('情绪指数 +0.0（互动传感器）')
    expect(text).not.toContain('+8.0')
    // The host's energy wins over the engine's own gauge.
    expect(text).toContain('精力：42/100')
  })

  it('falls back to the legacy scalar only when it has events behind it', () => {
    const state = {
      currentMood: 8,
      energy: 98,
      currentDesire: null,
      moodHistory: [{ value: 8, reason: 'praised', timestamp: 1 }],
    } as any
    const psyche = { hasEvidence: false, band: 'neutral', vad: { valence: 0, arousal: 0, dominance: 0 } } as any

    const text = formatDiary(state, psyche, [], 98)

    expect(text).toContain('情绪指数 +8.0（旧量表）')
  })

  it('says unknown when no mood event was ever recorded', () => {
    // ROOT CAUSE: `autoProcess(moodValue)` is never called by this app, so `currentMood` stayed 0
    // and every diary printed "+0.0（旧量表）" as if it were a measurement (report 2026-10-31 §2.3).
    const state = { currentMood: 0, energy: 98, currentDesire: null, moodHistory: [] } as any
    const psyche = { hasEvidence: false, band: 'neutral', vad: { valence: 0, arousal: 0, dominance: 0 } } as any

    const text = formatDiary(state, psyche, [], 98)

    expect(text).toContain('情绪指数 unknown（暂无评估）')
    expect(text).not.toContain('+0.0')
  })
})
