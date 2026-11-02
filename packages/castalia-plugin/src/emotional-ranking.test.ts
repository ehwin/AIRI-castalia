import type { MemorySalienceInput } from './vendor/engine/emotionalRanking'

import { describe, expect, it } from 'vitest'

import { injectionPolicy, policyAllowsInjection, rankBySalience } from './vendor/engine/emotionalRanking'

const NOW = 1_800_000_000_000

/** Three low moments and three warm ones, equal in every other respect. */
function candidates(): MemorySalienceInput[] {
  const make = (id: string, valence: number, arousal = 0.6): MemorySalienceInput => ({
    id,
    intensity: 0.6,
    importance: 0.6,
    accessTimes: [NOW - 3_600_000],
    vad: { valence, arousal },
  })
  return [
    make('tired-a', -0.6),
    make('tired-b', -0.55),
    make('tired-c', -0.5),
    make('warm-a', 0.6),
    make('warm-b', 0.55),
    make('warm-c', 0.5),
  ]
}

describe('emotional ranking', () => {
  // Mood-congruent recall is the intended mechanism, not a bug: a low mood should surface
  // the low moments. Measured on the live bank, the top six went from 3/6 negative at a
  // neutral mood to 6/6 at valence -0.7. The guard below is what keeps that from turning
  // into rumination.
  it('lets the current mood reorder which memories come first', () => {
    const low = rankBySalience(candidates(), NOW, { valence: -0.7, arousal: 0.6 })
    const high = rankBySalience(candidates(), NOW, { valence: 0.7, arousal: 0.6 })

    expect(low.slice(0, 3).every(hit => hit.id.startsWith('tired'))).toBe(true)
    expect(high.slice(0, 3).every(hit => hit.id.startsWith('warm'))).toBe(true)
  })

  // The guard: a memory of medium salience that matches a strongly negative mood is not
  // injected at all. Without it, a bad evening could pull the same bad evening into every
  // later turn — the loop the bank shows six near-copies of.
  it('keeps medium-salience memories from piling on a negative mood', () => {
    const lowMood = { valence: -0.7, arousal: 0.6 }
    const neutral = { valence: 0.1, arousal: 0.3 }

    expect(injectionPolicy(0.45, { mood: lowMood })).toBe('context-only')
    expect(policyAllowsInjection(injectionPolicy(0.45, { mood: lowMood }))).toBe(false)
    expect(injectionPolicy(0.45, { mood: neutral })).toBe('inject')
    // A strong memory still speaks, and a pinned one always does.
    expect(injectionPolicy(0.62, { mood: lowMood })).toBe('inject')
    expect(injectionPolicy(0.45, { mood: lowMood, pinned: true })).toBe('always')
  })
})
