// Adapted from Castalia-Anima `src/emotion.ts`.
// That project is MIT licensed. Copyright (c) 2026 ehwin.
// The full MIT text is in ../THIRD-PARTY-NOTICES.md.

/** Continuous valence, arousal, and dominance values used by Castalia. */
export interface VADVector {
  valence: number
  arousal: number
  dominance: number
}

export interface DecayedEmotion {
  vad: VADVector
  intensity: number
}

const halfLife = {
  valence: 24,
  arousal: 4,
  dominance: 36,
}

const nightMultiplier = {
  valence: 1.5,
  arousal: 3,
  dominance: 0.5,
}

function decayDimension(value: number, hours: number, hoursPerHalfLife: number, slowdown: number, multiplier: number) {
  if (hoursPerHalfLife <= 0)
    return value
  return value * Math.exp(-slowdown * multiplier * hours / hoursPerHalfLife)
}

/** Applies Castalia's per-dimension emotion decay, tsundere slowdown, and night-time rates. */
export function decayEmotion(vad: VADVector | null, hours: number, tsundereLevel = 0, now = new Date()): DecayedEmotion {
  if (!vad)
    return { vad: { valence: 0, arousal: 0, dominance: 0 }, intensity: 0 }

  const night = now.getHours() >= 22 || now.getHours() < 6
  const slowdown = 1 - 0.5 * Math.max(0, Math.min(10, tsundereLevel)) / 10
  const multiplier = night ? nightMultiplier : { valence: 1, arousal: 1, dominance: 1 }
  const decayed = {
    valence: decayDimension(vad.valence, Math.max(0, hours), halfLife.valence, slowdown, multiplier.valence),
    arousal: decayDimension(vad.arousal, Math.max(0, hours), halfLife.arousal, slowdown, multiplier.arousal),
    dominance: decayDimension(vad.dominance, Math.max(0, hours), halfLife.dominance, slowdown, multiplier.dominance),
  }

  return {
    vad: decayed,
    intensity: Math.min(1, (Math.abs(decayed.valence) + Math.abs(decayed.arousal) + Math.abs(decayed.dominance)) / 3),
  }
}

/** Returns one continuous VAD update toward the character's stable baseline. */
export function regressEmotionToBaseline(current: VADVector, baseline: VADVector, rate = 0.05): VADVector {
  return {
    valence: current.valence + rate * (baseline.valence - current.valence),
    arousal: current.arousal + rate * (baseline.arousal - current.arousal),
    dominance: current.dominance + rate * (baseline.dominance - current.dominance),
  }
}
