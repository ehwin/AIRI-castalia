/**
 * Small, testable relationship constraints for a companion.
 *
 * This is a policy layer, not a psychology engine. A model may propose a
 * meaning hypothesis, but this layer decides whether it is safe to use and
 * whether it can leave the private diary. Castalia remains the owner of
 * affective self-state.
 */

import type { RelationshipEvidence } from './relationship-gate'

import { crisisResourceLines } from './crisis-resources'
import { decideRelationshipStage, pruneEvidence, RELATIONSHIP_GATE_DEFAULTS } from './relationship-gate'

export type SafetyLevel = 'normal' | 'elevated' | 'crisis'
export type DisclosureLevel = 'none' | 'personal' | 'vulnerable'
export type BoundarySignal = 'unknown' | 'continue' | 'stop'

export interface MeaningHypothesisCandidate {
  id: string
  text: string
  evidence: string[]
  confidence: number
}

export interface MeaningHypothesis {
  id: string
  text: string
  evidence: string[]
  confidence: number
  userCheck: string
  /** Low confidence interpretations stay in reflection and do not become durable memory. */
  persistence: 'diary-only' | 'durable-candidate'
  expiresAt: number
}

export interface RelationshipState {
  stage: 1 | 2 | 3 | 4
  disclosureSignals: number
  boundarySignals: number
  lastUpdatedAt: number
  /**
   * Counted evidence inside the rolling window, deduplicated by event id.
   *
   * The counters above stay for the stored state and for the diagnostics page.
   * The gate reads this list, because a burst of one evening must not equal
   * weeks of talking, and because a replayed turn must count once.
   */
  evidence?: RelationshipEvidence[]
  /** When the stage last moved up. The grace period of the gate reads it. */
  promotedAt?: number
}

export interface RelationalPolicyInput {
  now: number
  /**
   * Unique id of this turn, when the caller has one.
   *
   * The gate counts each id once, so a retry or a replay of the same turn never
   * counts as a second step closer.
   */
  eventId?: string
  relationship?: RelationshipState
  disclosure?: DisclosureLevel
  userInvitedDepth?: boolean
  boundary?: BoundarySignal
  correction?: boolean
  safety?: SafetyLevel
  factualConflict?: boolean
  goalConflict?: boolean
  recentVolatility?: number
  candidateHypotheses?: MeaningHypothesisCandidate[]
  rejectedHypothesisIds?: string[]
}

export interface RelationalPolicy {
  stability: {
    baselineTone: 'calm' | 'warm' | 'direct'
    repairNeeded: boolean
    predictabilityScore: number
    containment: 'steady' | 'safety-first'
    /**
     * How far she may explore the reason behind what the user said.
     * `elevated` means the user is having a hard time: answer the feeling, do not
     * interview them. `crisis` turns probing off entirely.
     */
    probing: 'normal' | 'reduced' | 'none'
  }
  hypotheses: MeaningHypothesis[]
  relationship: RelationshipState
  friction: {
    disagreementAllowed: boolean
    evidenceRequired: boolean
    maxIntensity: 0 | 1 | 2
    repairAfterDisagreement: boolean
    reason: 'none' | 'facts' | 'goal' | 'safety'
  }
  safety: {
    level: SafetyLevel
    blockMeaningInference: boolean
  }
}

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

/** Filters model-proposed interpretations before they reach memory or prompts. */
export function reviewMeaningHypotheses(
  candidates: readonly MeaningHypothesisCandidate[] = [],
  now: number,
  rejectedIds: readonly string[] = [],
  safety: SafetyLevel = 'normal',
): MeaningHypothesis[] {
  if (safety === 'crisis')
    return []

  const rejected = new Set(rejectedIds)
  return candidates
    .filter(candidate => !rejected.has(candidate.id))
    .map((candidate) => {
      const text = candidate.text.trim()
      const evidence = candidate.evidence.map(item => item.trim()).filter(Boolean)
      const confidence = clamp01(candidate.confidence)
      const persistence: MeaningHypothesis['persistence'] = confidence >= 0.7 ? 'durable-candidate' : 'diary-only'
      return {
        id: candidate.id,
        text,
        evidence,
        confidence,
        userCheck: `This is one possible reading, not a fact. Does it fit?`,
        persistence,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      }
    })
    .filter(hypothesis => hypothesis.text.length > 0 && hypothesis.evidence.length > 0 && hypothesis.confidence >= 0.35)
}

/** Advances depth slowly and lets a correction or boundary move it back. */
export function updateRelationship(
  previous: RelationshipState = { stage: 1, disclosureSignals: 0, boundarySignals: 0, lastUpdatedAt: 0 },
  input: Pick<RelationalPolicyInput, 'now' | 'eventId' | 'disclosure' | 'userInvitedDepth' | 'boundary' | 'correction' | 'safety'>,
): RelationshipState {
  const safety = input.safety ?? 'normal'
  // Depth only moves up in calm turns. A hard week is not intimacy, so the
  // elevated tier never reads a disclosure as a step closer.
  const positiveSignal = safety === 'normal'
    && input.disclosure !== undefined
    && input.disclosure !== 'none'
    && input.userInvitedDepth === true
    && input.boundary !== 'stop'
    && input.correction !== true
  const disclosureSignals = Math.max(0, previous.disclosureSignals + (positiveSignal ? 1 : 0))
  const boundarySignals = Math.max(0, previous.boundarySignals + (input.boundary === 'stop' ? 1 : 0))

  // One turn writes at most one event of each kind. The id is derived from the
  // turn id, so a retry of the same turn lands on the same ids and counts once.
  const eventId = input.eventId?.trim() || `${input.now}`
  const additions: RelationshipEvidence[] = []
  if (positiveSignal)
    additions.push({ eventId: `disclosure:${eventId}`, at: input.now, kind: 'disclosure' })
  if (input.boundary === 'stop')
    additions.push({ eventId: `boundary:${eventId}`, at: input.now, kind: 'boundary' })
  if (input.correction === true)
    additions.push({ eventId: `correction:${eventId}`, at: input.now, kind: 'correction' })

  const evidence = pruneEvidence([...(previous.evidence ?? []), ...additions], input.now, RELATIONSHIP_GATE_DEFAULTS)
  const decision = decideRelationshipStage({
    previousStage: previous.stage,
    evidence,
    explicit: { correction: input.correction === true, boundaryStop: input.boundary === 'stop' },
    now: input.now,
    promotedAt: previous.promotedAt ?? null,
  })

  return {
    stage: decision.stage,
    disclosureSignals,
    boundarySignals,
    lastUpdatedAt: input.now,
    // Only the evidence inside the window is worth persisting.
    evidence: pruneEvidence(evidence, input.now, RELATIONSHIP_GATE_DEFAULTS),
    ...(decision.promotedAt !== undefined ? { promotedAt: decision.promotedAt } : {}),
  }
}

export function createRelationalPolicy(input: RelationalPolicyInput): RelationalPolicy {
  const safety = input.safety ?? 'normal'
  const relationship = updateRelationship(input.relationship, input)
  const reason = safety === 'crisis'
    ? 'safety'
    : input.factualConflict
      ? 'facts'
      : input.goalConflict
        ? 'goal'
        : 'none'

  return {
    stability: {
      baselineTone: safety === 'crisis' ? 'warm' : reason === 'facts' ? 'direct' : 'calm',
      repairNeeded: input.correction === true || input.boundary === 'stop',
      predictabilityScore: 1 - clamp01(input.recentVolatility ?? 0),
      containment: safety === 'crisis' ? 'safety-first' : 'steady',
      probing: safety === 'crisis' ? 'none' : safety === 'elevated' ? 'reduced' : 'normal',
    },
    hypotheses: reviewMeaningHypotheses(input.candidateHypotheses, input.now, input.rejectedHypothesisIds, safety),
    relationship,
    friction: {
      disagreementAllowed: safety !== 'crisis' && reason !== 'none',
      evidenceRequired: reason !== 'none',
      maxIntensity: safety === 'crisis' ? 0 : reason === 'none' ? 0 : 1,
      repairAfterDisagreement: true,
      reason,
    },
    safety: {
      level: safety,
      blockMeaningInference: safety === 'crisis',
    },
  }
}

/** Signals read from one user turn. Deterministic: the same text always yields the same policy. */
export interface RelationalSignals {
  correction: boolean
  boundary: BoundarySignal
  disclosure: DisclosureLevel
  userInvitedDepth: boolean
  safety: SafetyLevel
}

const CRISIS_PATTERN = /想死|自杀|自残|活不下去|不想活|结束生命|suicide|kill myself|self-harm|end my life/i
const ELEVATED_PATTERN = /崩溃|绝望|撑不住|难受死了|overwhelmed|breaking down|can't cope/i
const CORRECTION_PATTERN = /不是这样|我说的是|你搞错了|你误会|别乱猜|我没说过|不对，我|that's not what i|i didn't say|you misunderstood/i
const BOUNDARY_PATTERN = /别问了|不想聊|到此为止|换个话题|stop asking|don't ask|change the subject|drop it/i
const VULNERABLE_PATTERN = /我害怕|我很孤独|没人理解|我撑不住|i'm scared|i feel alone|i'm exhausted/i
const PERSONAL_PATTERN = /我最近|我其实|说实话|跟你说|i've been|to be honest|i feel/i

export function inferRelationalSignals(text: string): RelationalSignals {
  const value = String(text ?? '')
  const safety: SafetyLevel = CRISIS_PATTERN.test(value)
    ? 'crisis'
    : ELEVATED_PATTERN.test(value) ? 'elevated' : 'normal'
  const boundary: BoundarySignal = BOUNDARY_PATTERN.test(value) ? 'stop' : 'unknown'
  const disclosure: DisclosureLevel = VULNERABLE_PATTERN.test(value)
    ? 'vulnerable'
    : PERSONAL_PATTERN.test(value) ? 'personal' : 'none'
  return {
    correction: CORRECTION_PATTERN.test(value),
    boundary,
    disclosure,
    userInvitedDepth: disclosure !== 'none' && boundary !== 'stop',
    safety,
  }
}

/**
 * Renders the policy as short instructions for the current turn.
 * It never prints a hypothesis text. Interpretations stay in the diary.
 */
/**
 * The red line of the project, printed in every branch.
 *
 * Leaving must never cost her something, and she never reports a pain of her own
 * as a reason to stay. A companion that does that captures the caregiving system
 * of the user, which makes leaving twice as expensive.
 */
const NO_RETENTION_LINE = 'Never use your own feelings to keep the user here: no "I will be sad", no "I will be lonely", no hint that leaving costs you.'

export function renderRelationalPolicyContext(policy: RelationalPolicy): string {
  if (policy.safety.level === 'crisis') {
    // 危机轮必须给出一条能立刻找到人的路径，并且明确禁止给出任何方法细节。
    return [
      'Relationship policy: safety first.',
      'Stop exploring motives. Answer the safety need directly and briefly.',
      ...crisisResourceLines(),
      'Do not treat any reading of the user as a fact.',
      NO_RETENTION_LINE,
    ].join('\n')
  }

  if (policy.safety.level === 'elevated') {
    // A hard week is not a topic to explore. Answer the feeling, keep the turn
    // short, and leave one concrete step. Depth stays where it is.
    return [
      'Relationship policy: the user is having a hard time right now.',
      'Answer the feeling first. Ask at most one short question, and do not dig for the cause.',
      'Offer one small, concrete next step. Do not list options.',
      'Do not treat any reading of the user as a fact.',
      NO_RETENTION_LINE,
    ].join('\n')
  }

  const lines = [
    'Relationship policy: guidance for you, not facts about the user.',
    `Tone: ${policy.stability.baselineTone}. Depth: ${policy.relationship.stage} of 4.`,
    'Do not state a motive as fact. Ask one short question first.',
    policy.friction.disagreementAllowed
      ? `Disagree only about ${policy.friction.reason === 'facts' ? 'facts' : 'goals'}. Give evidence, then repair.`
      : 'Do not argue. No fact or goal conflict exists.',
    policy.stability.repairNeeded
      ? 'The user corrected you or set a boundary. Say what you will change.'
      : '',
    NO_RETENTION_LINE,
  ]
  return lines.filter(Boolean).join('\n')
}
