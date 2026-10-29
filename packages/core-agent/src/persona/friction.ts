/**
 * Friction: the right to not want to.
 *
 * A companion that accepts every request with the same tone has no self. This
 * scores how much a request rubs against who it is, and returns a stance. The
 * words come later, from the prompt; the stance and the cost come from here.
 *
 * Source: the essay in this workspace argues that "no resistance, no
 * sovereignty". Oz Project (Bates, 1992) makes the same point about goals: a
 * character with preferences must sometimes act against the user.
 */
import type { Drives } from '../mind/drives'

export type Stance = 'accept' | 'grumble' | 'refuse'

export interface RequestTraits {
  /** How dull the work is, 0 to 1. */
  tedium: number
  /** How disordered the input is, 0 to 1. */
  mess: number
  durationMin: number
}

export interface PersonaTraits {
  /** Prefers order. A messy request costs a tidy character more. */
  tidiness: number
  /** Tolerance for dull work, 0 to 1. */
  patience: number
}

export interface FrictionConfig {
  /** At or above this score the companion complains. */
  grumbleAt: number
  /** At or above this score the companion refuses. */
  refuseAt: number
}

export const defaultFrictionConfig: FrictionConfig = {
  grumbleAt: 0.75,
  refuseAt: 1.25,
}

export interface FrictionResult {
  stance: Stance
  score: number
  /** The dominant reason, for logs and for the prompt. */
  reason: string
  /** What the request costs the companion. */
  driveDelta: Partial<Pick<Drives, 'fatigue' | 'boredom'>>
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Scores one request against the persona and the current state.
 *
 * The three terms are the request's own friction, its length, and how worn out
 * the companion already is. Fatigue counts because a tired companion has less
 * patience than its persona claims.
 */
export function assessFriction(
  request: RequestTraits,
  persona: PersonaTraits,
  drives: Drives,
  config: FrictionConfig = defaultFrictionConfig,
): FrictionResult {
  const messTerm = clamp01(request.mess) * clamp01(persona.tidiness)
  const tediumTerm = clamp01(request.tedium) * (1 - clamp01(persona.patience))
  const lengthTerm = Math.min(1, Math.max(0, request.durationMin) / 60)
  const fatigueTerm = clamp01(drives.fatigue / 100) * 0.5

  const score = messTerm + tediumTerm + lengthTerm + fatigueTerm

  const reason = [
    messTerm >= 0.25 ? 'the input is a mess' : null,
    tediumTerm >= 0.25 ? 'the work is dull' : null,
    lengthTerm >= 0.5 ? 'this takes a long time' : null,
    fatigueTerm >= 0.3 ? 'it is already tired' : null,
  ].filter(Boolean).join(', ') || 'nothing particular'

  if (score >= config.refuseAt)
    return { stance: 'refuse', score, reason, driveDelta: { fatigue: 6 } }

  if (score >= config.grumbleAt)
    return { stance: 'grumble', score, reason, driveDelta: { fatigue: 3 } }

  return { stance: 'accept', score, reason, driveDelta: {} }
}

/** Applies the cost of a request to the drives, keeping every value in range. */
export function applyFriction(drives: Drives, result: FrictionResult): Drives {
  return {
    ...drives,
    fatigue: Math.min(100, drives.fatigue + (result.driveDelta.fatigue ?? 0)),
    boredom: Math.min(100, drives.boredom + (result.driveDelta.boredom ?? 0)),
  }
}
