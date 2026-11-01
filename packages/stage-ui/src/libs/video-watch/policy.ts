import { clamp } from 'es-toolkit/math'

/**
 * When she may watch a video she queued for herself.
 *
 * The decision is a pure function of her state, so it is testable without timers and explainable
 * in the log: the alternative — an LLM prompt run on every tick — would cost money to answer
 * "not now" ninety times an hour.
 *
 * A refusals costs nothing but the tick: it is re-asked on the next one.
 */

export interface VideoWatchInput {
  /** Epoch milliseconds. */
  now: number
  /** Milliseconds since the last chat turn, so she never starts a clip mid-conversation. */
  idleMs: number
  /** Milliseconds since the oldest pending item was queued. */
  queueAgeMs: number
  /** How many videos are waiting. */
  pending: number
  /** Videos she already watched today, local time. */
  watchedToday: number
  /** Epoch milliseconds of the last watch, or null when she never watched one. */
  lastWatchedAt: number | null
  /** Her curiosity, 0..1, from her own state. Scales how likely she is to start one. */
  curiosity: number
  /** A number in [0, 1), so the caller owns the randomness and a test can pin it. */
  random: number
}

export interface VideoWatchPolicy {
  /** She does not start a clip while a conversation is going. */
  minIdleMs: number
  /** The gap between two watches, so a queue is not emptied in a burst. */
  minGapMs: number
  /** Watches per local day. */
  dailyCap: number
  /** An item older than this is not "interesting" any more; the caller drops it. */
  staleAfterMs: number
  /** The chance at curiosity 0.5 and a fresh queue. */
  baseChance: number
  /** Local hours in which she does not start one, `[startHour, endHour)`. */
  quietHours: readonly [number, number]
}

export const VIDEO_WATCH_POLICY_DEFAULTS: VideoWatchPolicy = {
  minIdleMs: 5 * 60_000,
  minGapMs: 45 * 60_000,
  dailyCap: 3,
  staleAfterMs: 7 * 24 * 3_600_000,
  baseChance: 0.3,
  quietHours: [1, 8],
}

export type VideoWatchRefusal
  = | 'empty'
    | 'daily-cap'
    | 'too-soon'
    | 'busy'
    | 'quiet-hours'
    | 'stale'
    | 'chance'

export interface VideoWatchDecision {
  watch: boolean
  reason: 'due' | VideoWatchRefusal
  /** The odds this tick used, for the log. */
  chance: number
}

/**
 * Decides one tick.
 *
 * Order matters: the hard gates (empty, cap, gap, busy, quiet hours, stale) explain themselves
 * without randomness, and only a queue that passed all of them is rolled for.
 */
export function decideVideoWatch(input: VideoWatchInput, policy: VideoWatchPolicy = VIDEO_WATCH_POLICY_DEFAULTS): VideoWatchDecision {
  if (input.pending <= 0)
    return { watch: false, reason: 'empty', chance: 0 }
  if (input.watchedToday >= policy.dailyCap)
    return { watch: false, reason: 'daily-cap', chance: 0 }
  if (input.lastWatchedAt !== null && input.now - input.lastWatchedAt < policy.minGapMs)
    return { watch: false, reason: 'too-soon', chance: 0 }
  if (input.idleMs < policy.minIdleMs)
    return { watch: false, reason: 'busy', chance: 0 }
  if (isQuietHour(input.now, policy.quietHours))
    return { watch: false, reason: 'quiet-hours', chance: 0 }
  if (input.queueAgeMs > policy.staleAfterMs)
    return { watch: false, reason: 'stale', chance: 0 }

  // A longer wait and more curiosity both raise the odds, within reason: an hour of queueing
  // triples the base chance, and never past certainty.
  const ageBoost = 1 + Math.min(input.queueAgeMs / 3_600_000, 2)
  const chance = clamp(policy.baseChance * (0.5 + clamp(input.curiosity, 0, 1)) * ageBoost, 0, 0.95)

  return input.random < chance
    ? { watch: true, reason: 'due', chance }
    : { watch: false, reason: 'chance', chance }
}

/** `true` when `now` falls inside the quiet window, which may wrap midnight. */
export function isQuietHour(now: number, quietHours: readonly [number, number]): boolean {
  const hour = new Date(now).getHours()
  const [start, end] = quietHours
  return start === end ? false : start < end ? (hour >= start && hour < end) : (hour >= start || hour < end)
}
