/**
 * The gate that moves the relationship stage.
 *
 * Two paths move depth, and they must not borrow each other's rules.
 *
 * - The owner's own act. A correction ("do not call me that") or a boundary stop
 *   drops one level at once, with no hysteresis and no waiting period. The owner
 *   said it, so it is not a statistic. This is a deliberate choice: the projects
 *   that implement trust levels treat a report as evidence that waits for the
 *   next scheduled job, and a companion needs the owner's words to land now.
 * - Accumulated evidence. A promotion needs every criterion of the next level,
 *   not a weighted total, or one burst of one kind can buy a level alone. A
 *   decayed level holds until the criteria fall to `hysteresis` of its bar, so a
 *   quiet week never costs depth, and a promotion starts a grace period so a
 *   level is never lost right after it was earned.
 *
 * The hold bar is the whole anti-thrash rule here. The trust-level design that
 * this gate follows also refuses a demotion while the target level still meets
 * its own bar, and that check is deliberately dropped: the levels are
 * cumulative, so anything below the bar of level N still meets the bar of level
 * N-1, which would refuse every demotion except the one down to the first level.
 * One level per decision stays as the second half of the anti-thrash rule.
 *
 * Evidence is deduplicated by event id, so a retry or a replayed turn counts once.
 * Every decision is pure: the caller owns the clock and the stored state.
 */

export type RelationshipStage = 1 | 2 | 3 | 4

export interface RelationshipEvidence {
  /** Unique id of the event. The same id always counts once. */
  eventId: string
  /** When the event happened, in milliseconds. */
  at: number
  kind: 'disclosure' | 'boundary' | 'correction'
}

export interface RelationshipLevelRequirement {
  /** Distinct disclosure events inside the window. */
  disclosures: number
  /**
   * Distinct local days the counted disclosures span.
   *
   * A burst in one sitting is one day, so a single long evening cannot buy the
   * depth that weeks of talking buy.
   */
  distinctDays: number
}

export interface RelationshipGatePolicy {
  /** How far back evidence still counts. */
  windowMs: number
  /** The deepest level this companion can reach. */
  maxLevel: RelationshipStage
  /** The bar for each level above the first. */
  levels: Record<'2' | '3' | '4', RelationshipLevelRequirement>
  /** A promotion waits until the evidence spans at least this long. */
  minPromotionSpanMs: number
  /** A promotion waits this long after the previous one. */
  promotionCooldownMs: number
  /** The current level holds until its criteria fall to this share of the bar. */
  hysteresis: number
  /** No decay demotion inside this time after a promotion. */
  graceMs: number
  /** How many levels an explicit correction or boundary stop drops at once. */
  explicitDropLevels: number
}

/** One day, the unit the day span counts in. */
export const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * Starting values for a companion.
 *
 * The window is two months, so a persona that talks rarely still accumulates.
 * Level 4 asks for seven separate days, because the deepest level should cost
 * something a single good evening cannot pay.
 */
export const RELATIONSHIP_GATE_DEFAULTS: RelationshipGatePolicy = {
  windowMs: 60 * DAY_MS,
  maxLevel: 4,
  levels: {
    2: { disclosures: 2, distinctDays: 2 },
    3: { disclosures: 4, distinctDays: 4 },
    4: { disclosures: 6, distinctDays: 7 },
  },
  minPromotionSpanMs: 12 * HOUR_MS,
  promotionCooldownMs: 12 * HOUR_MS,
  hysteresis: 0.9,
  graceMs: 7 * DAY_MS,
  explicitDropLevels: 1,
}

export interface RelationshipGateCounts {
  disclosures: number
  distinctDays: number
  boundaries: number
  corrections: number
}

export type RelationshipGateReason
  /** The owner corrected her or asked her to stop, so depth dropped now. */
  = | 'explicit'
    /** Every criterion of the next level held. */
    | 'promoted'
    /** The criteria decayed below the hold bar. */
    | 'decayed'
    /** The evidence changed nothing. */
    | 'held'
    /** The policy or the clock was nonsense, so nothing moved. */
    | 'invalid'

export interface RelationshipGateDecision {
  stage: RelationshipStage
  reason: RelationshipGateReason
  counts: RelationshipGateCounts
  /** When this decision set the stage. A promotion sets it to `now`. */
  promotedAt: number
  /** When the evidence set that was counted first appeared. Null when nothing counted. */
  evidenceSince: number | null
}

function clampStage(value: number): RelationshipStage {
  return Math.min(4, Math.max(1, value)) as RelationshipStage
}

function isSaneRequirement(requirement: RelationshipLevelRequirement | undefined): boolean {
  return requirement !== undefined
    && Number.isFinite(requirement.disclosures) && requirement.disclosures >= 1
    && Number.isFinite(requirement.distinctDays) && requirement.distinctDays >= 1
}

export function isSaneGatePolicy(policy: RelationshipGatePolicy): boolean {
  return Number.isFinite(policy.windowMs) && policy.windowMs > 0
    && isSaneRequirement(policy.levels?.[2]) && isSaneRequirement(policy.levels?.[3]) && isSaneRequirement(policy.levels?.[4])
    && Number.isFinite(policy.minPromotionSpanMs) && policy.minPromotionSpanMs >= 0
    && Number.isFinite(policy.promotionCooldownMs) && policy.promotionCooldownMs >= 0
    && Number.isFinite(policy.hysteresis) && policy.hysteresis > 0 && policy.hysteresis <= 1
    && Number.isFinite(policy.graceMs) && policy.graceMs >= 0
    && Number.isFinite(policy.explicitDropLevels) && policy.explicitDropLevels >= 1
}

/** The local day index of a moment. Two events on one day share it. */
function localDay(at: number): number {
  const date = new Date(at)
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / DAY_MS)
}

/**
 * Keeps the newest evidence inside the window and drops repeated ids.
 *
 * The newest event always survives, even when it is older than the window, so a
 * companion that talks twice a year still counts what it has.
 */
export function pruneEvidence(
  evidence: readonly RelationshipEvidence[],
  now: number,
  policy: RelationshipGatePolicy,
  cap = 200,
): RelationshipEvidence[] {
  const seen = new Set<string>()
  const kept: RelationshipEvidence[] = []
  for (const item of [...evidence].sort((left, right) => right.at - left.at)) {
    if (!item || typeof item.eventId !== 'string' || item.eventId.length === 0)
      continue
    if (!Number.isFinite(item.at))
      continue
    if (seen.has(item.eventId))
      continue
    if (item.at < now - policy.windowMs && kept.length > 0)
      continue
    seen.add(item.eventId)
    kept.push(item)
    if (kept.length >= cap)
      break
  }
  return kept
}

export function countEvidence(evidence: readonly RelationshipEvidence[]): RelationshipGateCounts {
  const disclosures = evidence.filter(item => item.kind === 'disclosure')
  const days = new Set(disclosures.map(item => localDay(item.at)))
  return {
    disclosures: disclosures.length,
    distinctDays: days.size,
    boundaries: evidence.filter(item => item.kind === 'boundary').length,
    corrections: evidence.filter(item => item.kind === 'correction').length,
  }
}

/** Every criterion of one level holds. This is an AND, never a weighted total. */
function meetsLevel(counts: RelationshipGateCounts, requirement: RelationshipLevelRequirement): boolean {
  return counts.disclosures >= requirement.disclosures && counts.distinctDays >= requirement.distinctDays
}

/** The criteria fell to the hold bar of the current level. */
function fellBelowHold(counts: RelationshipGateCounts, requirement: RelationshipLevelRequirement, hysteresis: number): boolean {
  return counts.disclosures < requirement.disclosures * hysteresis
    || counts.distinctDays < requirement.distinctDays * hysteresis
}

export interface RelationshipGateInput {
  previousStage: RelationshipStage
  evidence: readonly RelationshipEvidence[]
  /** This turn: the owner corrected her, or asked her to stop. */
  explicit: { correction: boolean, boundaryStop: boolean }
  now: number
  /** When the stage last moved up. Null means it never did. */
  promotedAt: number | null
  policy?: RelationshipGatePolicy
}

/**
 * The stage after this turn.
 *
 * The order is deliberate: the owner's own act first, then a promotion, then a
 * decay, then holding. One call moves the stage by at most one level.
 */
export function decideRelationshipStage(input: RelationshipGateInput): RelationshipGateDecision {
  const policy = input.policy ?? RELATIONSHIP_GATE_DEFAULTS
  const stage = clampStage(input.previousStage)
  const evidence = pruneEvidence(input.evidence ?? [], input.now, policy)
  const counts = countEvidence(evidence)
  const evidenceSince = evidence.length > 0 ? Math.min(...evidence.map(item => item.at)) : null
  // Never promoted means neither the cooldown nor the grace period can apply.
  const lastPromotedAt = Number.isFinite(input.promotedAt as number) ? input.promotedAt : null
  const promotedAt = lastPromotedAt ?? input.now

  if (!isSaneGatePolicy(policy) || !Number.isFinite(input.now)) {
    return { stage, reason: 'invalid', counts, promotedAt, evidenceSince }
  }

  // 1. The owner's own act. No hold bar, no grace period, no interlock.
  if (input.explicit.correction || input.explicit.boundaryStop) {
    return {
      stage: clampStage(stage - policy.explicitDropLevels),
      reason: 'explicit',
      counts,
      promotedAt,
      evidenceSince,
    }
  }

  // 2. Promotion needs every criterion, a long enough span, and a settled stage.
  const next = clampStage(stage + 1)
  if (stage < policy.maxLevel && next !== stage) {
    const requirement = policy.levels[String(next) as '2' | '3' | '4']
    const span = evidenceSince === null ? 0 : input.now - evidenceSince
    const coolEnough = lastPromotedAt === null || input.now - lastPromotedAt >= policy.promotionCooldownMs
    if (meetsLevel(counts, requirement) && span >= policy.minPromotionSpanMs && coolEnough) {
      return { stage: next, reason: 'promoted', counts, promotedAt: input.now, evidenceSince }
    }
  }

  // 3. A decayed level steps down, unless grace holds it.
  //
  // An empty list means "no evidence recorded", not "evidence gone": pruning keeps
  // the newest row whatever its age. A state from before this gate has counters but
  // no list, and must not read as a thin relationship.
  if (stage > 1 && evidence.length > 0) {
    const requirement = policy.levels[String(stage) as '2' | '3' | '4']
    const inGrace = lastPromotedAt !== null && input.now - lastPromotedAt < policy.graceMs
    if (!inGrace && fellBelowHold(counts, requirement, policy.hysteresis))
      return { stage: clampStage(stage - 1), reason: 'decayed', counts, promotedAt, evidenceSince }
  }

  return { stage, reason: 'held', counts, promotedAt, evidenceSince }
}
