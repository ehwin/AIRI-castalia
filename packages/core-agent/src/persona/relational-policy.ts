/**
 * Small, testable relationship constraints for a companion.
 *
 * This is a policy layer, not a psychology engine. A model may propose a
 * meaning hypothesis, but this layer decides whether it is safe to use and
 * whether it can leave the private diary. Castalia remains the owner of
 * affective self-state.
 */

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
}

export interface RelationalPolicyInput {
  now: number
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
  input: Pick<RelationalPolicyInput, 'now' | 'disclosure' | 'userInvitedDepth' | 'boundary' | 'correction'>,
): RelationshipState {
  const positiveSignal = input.disclosure !== undefined
    && input.disclosure !== 'none'
    && input.userInvitedDepth === true
    && input.boundary !== 'stop'
    && input.correction !== true
  const disclosureSignals = Math.max(0, previous.disclosureSignals + (positiveSignal ? 1 : 0))
  const boundarySignals = Math.max(0, previous.boundarySignals + (input.boundary === 'stop' ? 1 : 0))
  const candidateStage = Math.min(4, 1 + Math.floor(disclosureSignals / 2)) as 1 | 2 | 3 | 4
  const stage = input.correction || input.boundary === 'stop'
    ? Math.max(1, previous.stage - 1) as 1 | 2 | 3 | 4
    : Math.max(previous.stage, candidateStage) as 1 | 2 | 3 | 4

  return { stage, disclosureSignals, boundarySignals, lastUpdatedAt: input.now }
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
export function renderRelationalPolicyContext(policy: RelationalPolicy): string {
  if (policy.safety.level === 'crisis') {
    return [
      'Relationship policy: safety first.',
      'Stop exploring motives. Answer the safety need directly and briefly.',
      'Do not treat any reading of the user as a fact.',
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
  ]
  return lines.filter(Boolean).join('\n')
}
