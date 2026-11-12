// Adapted from Castalia-Anima `src/emotion.ts`.
// That project is MIT licensed. Copyright (c) 2026 ehwin.
// The full MIT text is in ../THIRD-PARTY-NOTICES.md.

/**
 * Continuous valence, arousal, and dominance values used by Castalia.
 *
 * Only the shape lives here. Decay and regression to the baseline belong to the engine
 * (`vendor/engine/psycheState.ts`), which owns the fast/slow layers, the evidence clock and
 * the band. A second decay in this package was measured by no one, drifted from the engine,
 * and would have answered the same question differently — it was removed, not kept as an
 * alternative.
 */
export interface VADVector {
  valence: number
  arousal: number
  dominance: number
}
