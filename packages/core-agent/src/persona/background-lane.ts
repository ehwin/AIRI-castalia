/**
 * The background lane: what the companion thinks about when nobody asks.
 *
 * A companion with no background lane has an empty inner stream, so there is
 * nothing to be lost in thought about. This turns observations into private
 * thoughts at a low rate, so most ticks produce nothing.
 *
 * Source: Generative Agents (Park et al., UIST 2023) runs reflection on a
 * schedule, not on every step. The rate matters more than the prompt.
 */
import type { Drives } from '../mind/drives'
import type { Thought } from './inner-stream'

export interface LaneInput {
  now: number
  drives: Drives
  /** Things the host noticed, oldest first. The lane does not collect them. */
  observations: string[]
  /** A number in 0 to 1 from the caller, so this stays pure. */
  roll: number
  /** When the last thought was written. A companion that dwells every minute is not quiet. */
  lastThoughtAt?: number
}

export interface LaneConfig {
  /** Boredom needed before a thought about the observations feels natural. */
  minBoredom: number
  /** Chance that a tick with observations produces a thought. */
  chance: number
  /** Shortest gap between two thoughts, so the stream stays readable. */
  minGapMs: number
}

export const defaultLaneConfig: LaneConfig = {
  minBoredom: 25,
  chance: 0.25,
  minGapMs: 10 * 60_000,
}

/**
 * Returns one private thought, or `undefined` when this tick stays quiet.
 *
 * Four gates, in order: there is something to think about, the companion is
 * bored enough to dwell on it, enough time passed since the last thought, and
 * the roll passes. Quiet is the common case.
 */
export function composeThought(
  input: LaneInput,
  config: LaneConfig = defaultLaneConfig,
): Thought | undefined {
  const observations = input.observations.filter(text => text.trim().length > 0)
  if (observations.length === 0)
    return undefined

  if (input.drives.boredom < config.minBoredom)
    return undefined

  if (input.lastThoughtAt !== undefined && input.now - input.lastThoughtAt < config.minGapMs)
    return undefined

  if (input.roll >= config.chance)
    return undefined

  // Spread the roll across the observations so a caller can make the pick vary.
  const spread = Math.min(0.999, input.roll / config.chance)
  const pick = observations[Math.floor(spread * observations.length)]

  return {
    id: `thought-${input.now}`,
    at: input.now,
    text: `noticed: ${pick}`,
    visibility: 'private',
  }
}
