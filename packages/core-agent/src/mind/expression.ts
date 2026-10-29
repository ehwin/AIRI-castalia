/**
 * Expression ladder.
 *
 * An inhibited companion must not go silent. It drops one level instead, from
 * speech to a bubble to a gesture. A user who sees a small movement understands
 * that the companion held something back. A user who sees nothing understands
 * nothing.
 *
 * Source: the inhibition rule in `DESIGN-mind-dual-loop.md`. The satori bot in
 * `integrations/satori-bot` has no ladder, so it either speaks or stays silent.
 */
import type { Gates, MindAction } from './drives'

/**
 * How the companion shows a decision.
 * - `L0` renders a gesture. It costs nothing and never needs permission.
 * - `L1` shows a short bubble with the current private thought.
 * - `L2` starts a real turn, which calls the main model.
 */
export type ExpressionLevel = 'L0' | 'L1' | 'L2'

export interface ProvocationPolicy {
  /** Milliseconds that must pass between two spoken turns. */
  minGapMs: number
  /** Spoken turns allowed in one hour. */
  maxPerHour: number
  /**
   * Milliseconds that must pass between two bubbles.
   *
   * A held-back thought repeats on every tick. Without this gap a blocked
   * companion shows a bubble every tick, which is the popup machine that the
   * ladder exists to prevent.
   */
  bubbleMinGapMs: number
}

export const defaultProvocationPolicy: ProvocationPolicy = {
  minGapMs: 20 * 60_000,
  maxPerHour: 2,
  bubbleMinGapMs: 3 * 60_000,
}

/**
 * Reports whether the companion can speak now.
 *
 * The gap and the hourly cap stop a loop that feeds itself. Without them a
 * reply raises curiosity, curiosity provokes again, and the user gets a
 * machine that talks to itself.
 */
export function mayProvoke(
  now: number,
  lastSpokeAt: number,
  spokenLastHour: number,
  policy: ProvocationPolicy = defaultProvocationPolicy,
): boolean {
  const gapPassed = now - lastSpokeAt >= policy.minGapMs
  const budgetLeft = spokenLastHour < policy.maxPerHour
  return gapPassed && budgetLeft
}

export interface ExpressionPlan {
  level: ExpressionLevel
  /** True when the companion wanted to talk and the gates or the policy stopped it. */
  heldBack: boolean
}

export interface PlanInput {
  action: MindAction
  gates: Gates
  now: number
  lastSpokeAt: number
  spokenLastHour: number
  /** The time of the last bubble, or zero when none was shown. */
  lastBubbleAt: number
  policy?: ProvocationPolicy
}

/**
 * Maps an action to the loudest level that the gates and the policy allow.
 *
 * A held-back invitation becomes `L1`, never silence. The bubble carries the
 * same private thought, so the user can ask about it later.
 */
export function planExpression(input: PlanInput): ExpressionPlan {
  const { action, gates, now, lastSpokeAt, lastBubbleAt, spokenLastHour } = input
  const policy = input.policy ?? defaultProvocationPolicy

  if (action === 'provoke') {
    const allowed = gates.allowProvoke && mayProvoke(now, lastSpokeAt, spokenLastHour, policy)
    if (allowed)
      return { level: 'L2', heldBack: false }

    const bubbleAllowed = now - lastBubbleAt >= policy.bubbleMinGapMs
    return bubbleAllowed
      ? { level: 'L1', heldBack: true }
      : { level: 'L0', heldBack: true }
  }

  // A private thought needs no bubble, and rest shows only a small gesture.
  return { level: 'L0', heldBack: false }
}
