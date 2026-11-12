/**
 * Traffic control for messages that the character starts itself.
 *
 * The speak policies answer "does she want to speak". This module answers the
 * separate question "may this message go out at all". A policy knows the drives;
 * it cannot know the clock on the wall, how many notices already went out today,
 * or whether the owner is asleep. Every refusal carries a reason and, when the
 * refusal is time-based, the moment the caller can ask again.
 *
 * The state is a plain value. Each recorder returns a new state, so a test can
 * replay a sequence and compare states instead of trusting a mutation.
 *
 * Every gate fails closed: a nonsense policy or a nonsense clock refuses speech.
 * Silence is the safe failure for a companion that speaks on its own.
 */

export type OutboundRefusalReason
  = | 'daily-cap'
    | 'duplicate'
    | 'min-gap'
    | 'paused'
    | 'quiet-hours'
    | 'unanswered-pause'

export type OutboundReason = OutboundRefusalReason | 'allowed'

export interface OutboundPolicy {
  /** Shortest wait between two self-initiated messages. */
  minGapMs: number
  /** First hour with no self-initiated message, in the caller's local time. */
  quietStartHour: number
  /** First hour that is awake again. A window that crosses midnight is normal. */
  quietEndHour: number
  /** A repeat of the same topic inside this window is dropped. */
  dedupeWindowMs: number
  /** Most self-initiated messages inside one rolling day. */
  dailyCap: number
  /** Each message the owner left unanswered stretches the next wait. */
  unansweredGrowth: number
  /** The stretched wait factor never passes this value. */
  unansweredGrowthCap: number
  /** After this many unanswered messages, outbound waits for the owner. */
  pauseAfterUnanswered: number
  /**
   * How far the wait after a message may wander, as a fraction of `minGapMs`.
   *
   * A fixed gap is a metronome: every message lands on the hour mark, so the
   * owner can predict her and no day differs from the last. Human inter-event
   * times are bursty rather than periodic (Barabási 2005; Vázquez et al. 2006),
   * so each send draws the next wait inside `± gapSpread`. 0 restores the old
   * fixed gap; the value is clamped to 0.6 so a draw cannot swallow the pacing.
   */
  gapSpread?: number
}

export interface OutboundState {
  /** When the current rolling day started, in milliseconds. */
  dayStartedAt: number
  /** Self-initiated messages inside the current rolling day. */
  sentToday: number
  /** Time of the last self-initiated message, or null when there is none. */
  lastSentAt: number | null
  /** Topic key to the time it went out, for the topics inside the dedupe window. */
  recentTopics: Readonly<Record<string, number>>
  /** Self-initiated messages sent since the last owner message. */
  unanswered: number
  /** True when a setting or the owner asked for silence. */
  paused: boolean
  /**
   * The factor for the wait that started at `lastSentAt`.
   *
   * Drawn once when the message goes out, then stored: drawing it again on every
   * tick would let a message slip out earlier each time the caller asked.
   */
  gapFactor?: number
}

export interface OutboundRequest {
  /** Wall clock in milliseconds. */
  now: number
  /** Topic key of the message about to go out. */
  topic: string
  /**
   * Local hour of `now`, 0 to 23. The caller reads the clock, so this module
   * never touches a timezone and a test can pick any hour it wants.
   */
  hour: number
}

export interface OutboundDecision {
  allow: boolean
  reason: OutboundReason
  /** When the caller can ask again, in milliseconds. Set for time-based refusals. */
  retryAtMs?: number
  /**
   * Factor for the base wait this round. It grows with the unanswered count, so
   * a companion that nobody answers slows down instead of talking into a void.
   */
  intervalMultiplier: number
}

export const OUTBOUND_POLICY_DEFAULTS: OutboundPolicy = {
  minGapMs: 3_600_000,
  quietStartHour: 23,
  quietEndHour: 7,
  dedupeWindowMs: 14_400_000,
  dailyCap: 8,
  unansweredGrowth: 1.35,
  unansweredGrowthCap: 2.2,
  pauseAfterUnanswered: 3,
}

/** One day, the window that `dailyCap` counts over. */
export const DAY_MS = 86_400_000

/** The widest a single draw may move the wait, as a fraction of the base gap. */
const MAX_GAP_SPREAD = 0.6
/** Default spread: the wait after a message lands between 65% and 135% of it. */
export const DEFAULT_GAP_SPREAD = 0.35

function spreadOf(policy: OutboundPolicy): number {
  const spread = policy.gapSpread ?? DEFAULT_GAP_SPREAD
  if (!Number.isFinite(spread) || spread < 0)
    return DEFAULT_GAP_SPREAD
  return Math.min(MAX_GAP_SPREAD, spread)
}

/** The stored draw, or 1 when this state predates the field. */
export function gapFactorOf(state: OutboundState, policy: OutboundPolicy = OUTBOUND_POLICY_DEFAULTS): number {
  const spread = spreadOf(policy)
  const factor = state.gapFactor
  if (typeof factor !== 'number' || !Number.isFinite(factor))
    return 1
  return Math.min(1 + spread, Math.max(1 - spread, factor))
}

/**
 * The wait factor for the message after this one.
 *
 * Drawn at send time and stored, so the gap belongs to that message: asking the
 * gate twice cannot shorten it. Moved by the distance between the character and
 * the owner only through `unansweredMultiplier`, which stays separate.
 */
export function nextGapFactor(random: () => number = Math.random, spread = DEFAULT_GAP_SPREAD): number {
  const width = Math.min(MAX_GAP_SPREAD, Math.max(0, spread))
  const draw = random()
  const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0.5
  return 1 + width * (2 * unit - 1)
}

export function createOutboundState(now: number): OutboundState {
  return {
    dayStartedAt: now,
    sentToday: 0,
    lastSentAt: null,
    recentTopics: {},
    unanswered: 0,
    paused: false,
  }
}

function isSaneHour(hour: number): boolean {
  return Number.isFinite(hour) && hour >= 0 && hour < 24
}

function isSanePolicy(policy: OutboundPolicy): boolean {
  return Number.isFinite(policy.minGapMs) && policy.minGapMs >= 0
    && isSaneHour(policy.quietStartHour) && isSaneHour(policy.quietEndHour)
    && Number.isFinite(policy.dedupeWindowMs) && policy.dedupeWindowMs >= 0
    && Number.isFinite(policy.dailyCap) && policy.dailyCap >= 0
    && Number.isFinite(policy.unansweredGrowth) && policy.unansweredGrowth >= 1
    && Number.isFinite(policy.unansweredGrowthCap) && policy.unansweredGrowthCap >= 1
    && Number.isFinite(policy.pauseAfterUnanswered) && policy.pauseAfterUnanswered >= 1
}

/** True inside the window. A window that crosses midnight counts as two ranges. */
export function isQuietHour(hour: number, policy: OutboundPolicy): boolean {
  if (policy.quietStartHour === policy.quietEndHour) {
    return false
  }
  if (policy.quietStartHour < policy.quietEndHour) {
    return hour >= policy.quietStartHour && hour < policy.quietEndHour
  }
  return hour >= policy.quietStartHour || hour < policy.quietEndHour
}

/** The wait factor for the current unanswered count. 1 when every message was answered. */
export function unansweredMultiplier(state: OutboundState, policy: OutboundPolicy): number {
  const grown = policy.unansweredGrowth ** Math.max(0, state.unanswered)
  return Math.min(policy.unansweredGrowthCap, grown)
}

/** The self-initiated messages inside the rolling day that contains `now`. */
function sentTodayAt(state: OutboundState, now: number): number {
  return now - state.dayStartedAt >= DAY_MS ? 0 : state.sentToday
}

/** The next moment the clock reaches the end of the quiet window. */
function quietWindowEnd(now: number, policy: OutboundPolicy): number {
  const end = new Date(now)
  end.setMinutes(0, 0, 0)
  end.setHours(policy.quietEndHour)
  if (end.getTime() <= now) {
    end.setDate(end.getDate() + 1)
  }
  return end.getTime()
}

/**
 * Decides whether one self-initiated message may go out.
 *
 * The checks run in one fixed order, so the reason names the first thing that
 * blocked the message: pause, quiet hours, unanswered pause, minimum gap,
 * duplicate topic, then the daily cap.
 */
export function decideOutbound(
  request: OutboundRequest,
  state: OutboundState,
  policy: OutboundPolicy = OUTBOUND_POLICY_DEFAULTS,
): OutboundDecision {
  const multiplier = isSanePolicy(policy) ? unansweredMultiplier(state, policy) : 1
  if (!isSanePolicy(policy) || !Number.isFinite(request.now) || !isSaneHour(request.hour)) {
    return { allow: false, reason: 'paused', intervalMultiplier: multiplier }
  }

  if (state.paused) {
    return { allow: false, reason: 'paused', intervalMultiplier: multiplier }
  }

  if (isQuietHour(request.hour, policy)) {
    return {
      allow: false,
      reason: 'quiet-hours',
      retryAtMs: quietWindowEnd(request.now, policy),
      intervalMultiplier: multiplier,
    }
  }

  if (state.unanswered >= policy.pauseAfterUnanswered) {
    return { allow: false, reason: 'unanswered-pause', intervalMultiplier: multiplier }
  }

  if (state.lastSentAt !== null) {
    const earliest = state.lastSentAt + policy.minGapMs * multiplier * gapFactorOf(state, policy)
    if (request.now < earliest) {
      return { allow: false, reason: 'min-gap', retryAtMs: earliest, intervalMultiplier: multiplier }
    }
  }

  const lastTopicAt = state.recentTopics[request.topic]
  if (typeof lastTopicAt === 'number' && request.now - lastTopicAt < policy.dedupeWindowMs) {
    return {
      allow: false,
      reason: 'duplicate',
      retryAtMs: lastTopicAt + policy.dedupeWindowMs,
      intervalMultiplier: multiplier,
    }
  }

  if (sentTodayAt(state, request.now) >= policy.dailyCap) {
    return {
      allow: false,
      reason: 'daily-cap',
      retryAtMs: state.dayStartedAt + DAY_MS,
      intervalMultiplier: multiplier,
    }
  }

  return { allow: true, reason: 'allowed', intervalMultiplier: multiplier }
}

/** Records a message that went out. Rolls the day, counts it, and remembers its topic. */
export function recordOutbound(
  state: OutboundState,
  request: OutboundRequest,
  options: { random?: () => number, gapSpread?: number } = {},
): OutboundState {
  const rolled = request.now - state.dayStartedAt >= DAY_MS
    ? { dayStartedAt: request.now, sentToday: 0 }
    : { dayStartedAt: state.dayStartedAt, sentToday: state.sentToday }
  return {
    ...state,
    dayStartedAt: rolled.dayStartedAt,
    sentToday: rolled.sentToday + 1,
    lastSentAt: request.now,
    recentTopics: { ...state.recentTopics, [request.topic]: request.now },
    unanswered: state.unanswered + 1,
    // Drawn here, once per message: the next wait belongs to this send.
    gapFactor: options.random ? nextGapFactor(options.random, options.gapSpread) : state.gapFactor,
  }
}

/**
 * Records an owner message.
 *
 * The owner answered, so the unanswered run ends, the slower pace resets, and an
 * unanswered pause lifts. A pause that the owner set by hand stays: only
 * `setPaused` clears it.
 */
export function recordOwnerMessage(state: OutboundState): OutboundState {
  return { ...state, unanswered: 0 }
}

/** Sets or clears the silence switch. A hand-set pause outlives an owner message. */
export function setPaused(state: OutboundState, paused: boolean): OutboundState {
  return { ...state, paused }
}
