import { describe, expect, it } from 'vitest'

import { decayEmotion, regressEmotionToBaseline } from './emotion'

describe('castalia emotion model', () => {
  it('decays arousal faster than valence during daytime', () => {
    const { vad } = decayEmotion({ valence: 1, arousal: 1, dominance: 1 }, 4, 0, new Date('2026-01-01T12:00:00'))
    expect(vad.arousal).toBeLessThan(vad.valence)
    expect(vad.valence).toBeLessThan(1)
  })

  it('slows emotional decay as the Castalia tsundere setting rises', () => {
    const vad = { valence: 1, arousal: 1, dominance: 1 }
    const now = new Date('2026-01-01T12:00:00')
    expect(decayEmotion(vad, 12, 10, now).vad.valence).toBeGreaterThan(decayEmotion(vad, 12, 0, now).vad.valence)
  })

  it('moves emotion a bounded step toward the personality baseline', () => {
    expect(regressEmotionToBaseline({ valence: -1, arousal: 0, dominance: 0 }, { valence: 1, arousal: 1, dominance: -1 })).toEqual({
      valence: -0.9,
      arousal: 0.05,
      dominance: -0.05,
    })
  })
})
