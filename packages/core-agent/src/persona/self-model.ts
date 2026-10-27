/**
 * A self model built from predictions and observed outcomes.
 *
 * The host records outcomes after an action. Castalia stores the evidence and
 * supplies related memories. This module updates evidence balance without
 * inventing claims or choosing which memories to retrieve.
 */

export type EvidencePolarity = 'supports' | 'contradicts'

export interface SelfPrediction {
  id: string
  assessmentKey: string
  claim: string
  expectedOutcome: string
  createdAt: number
}

export interface SelfOutcome {
  predictionId: string
  observedOutcome: string
  supportsClaim: boolean
  observedAt: number
  affect?: AffectiveContext
}

export interface AffectiveContext {
  /** Castalia agent mood on its -10 to 10 scale. */
  mood?: number
  /** Castalia agent energy on its 0 to 100 scale. */
  energy?: number
  /** Castalia agent's current desire, if one is active. */
  desire?: string
  /** Castalia's current VAD snapshot. */
  vad?: {
    valence: number
    arousal: number
    dominance: number
  }
}

export interface CastaliaAgentState {
  currentMood: number
  energy: number
  currentDesire: string | null
}

export interface SelfEvidence {
  id: string
  at: number
  polarity: EvidencePolarity
  summary: string
}

export interface SelfAssessment {
  key: string
  claim: string
  evidenceBalance: number
  supportCount: number
  contradictionCount: number
  evidence: SelfEvidence[]
  updatedAt: number
}

export interface SelfModel {
  assessments: SelfAssessment[]
}

export interface SelfReview {
  prediction: SelfPrediction
  outcome: SelfOutcome
  evidence: SelfEvidence
  assessment: SelfAssessment
  model: SelfModel
}

/** Fields accepted by Castalia's existing `memory_save` operation. */
export interface CastaliaSelfMemory {
  text: string
  type: 'episodic'
  memType: 'project'
  category: 'self_model_evidence'
  emotionalImpact?: number
  tags: string[]
  importance: number
  tier: 'standard'
  source: 'airi:self-model'
  subject: 'self'
  skipEmbed: boolean
}

export interface CastaliaSelfMemoryRecord {
  id: string
  text: string
  createdAt: string
}

const evidenceLimit = 12

/** Creates an empty self model. */
export function createSelfModel(): SelfModel {
  return { assessments: [] }
}

/** Projects Castalia's current self state into prediction evidence. */
export function affectFromCastalia(
  state: CastaliaAgentState,
  vad?: AffectiveContext['vad'],
): AffectiveContext {
  const affect: AffectiveContext = {
    mood: state.currentMood,
    energy: state.energy,
    ...(state.currentDesire ? { desire: state.currentDesire } : {}),
    ...(vad ? { vad } : {}),
  }
  validateAffectiveContext(affect)
  return affect
}

/**
 * Reviews one prediction against an observed outcome.
 *
 * The caller decides whether the outcome supports the claim. This function
 * records that evidence and uses a smoothed support ratio. This ratio is not
 * a calibrated probability because outcomes are not independent samples.
 */
export function reviewSelfPrediction(
  model: SelfModel,
  prediction: SelfPrediction,
  outcome: SelfOutcome,
): SelfReview {
  if (prediction.id !== outcome.predictionId)
    throw new Error('The outcome must refer to its prediction.')
  if (!prediction.id.trim() || !prediction.assessmentKey.trim() || !prediction.claim.trim())
    throw new Error('A prediction needs an id, assessment key, and claim.')
  if (!prediction.expectedOutcome.trim() || !outcome.observedOutcome.trim())
    throw new Error('A prediction review needs expected and observed outcomes.')
  if (!Number.isFinite(prediction.createdAt) || !Number.isFinite(outcome.observedAt))
    throw new Error('Prediction timestamps must be finite numbers.')
  if (outcome.observedAt < prediction.createdAt)
    throw new Error('An outcome cannot precede its prediction.')
  validateAffectiveContext(outcome.affect)

  const polarity: EvidencePolarity = outcome.supportsClaim ? 'supports' : 'contradicts'
  const evidence: SelfEvidence = {
    id: prediction.id,
    at: outcome.observedAt,
    polarity,
    summary: [
      `Expected: ${prediction.expectedOutcome}. Observed: ${outcome.observedOutcome}.`,
      formatAffectiveContext(outcome.affect),
    ].filter(Boolean).join(' '),
  }
  const previous = model.assessments.find(item => item.key === prediction.assessmentKey)
  if (previous && previous.claim !== prediction.claim)
    throw new Error('A claim cannot change while it keeps the same assessment key.')
  if (previous?.evidence.some(item => item.id === evidence.id)) {
    return {
      prediction,
      outcome,
      evidence,
      assessment: previous,
      model,
    }
  }

  const supportCount = (previous?.supportCount ?? 0) + Number(outcome.supportsClaim)
  const contradictionCount = (previous?.contradictionCount ?? 0) + Number(!outcome.supportsClaim)
  const assessment: SelfAssessment = {
    key: prediction.assessmentKey,
    claim: prediction.claim,
    supportCount,
    contradictionCount,
    evidenceBalance: (supportCount + 1) / (supportCount + contradictionCount + 2),
    evidence: [...(previous?.evidence ?? []), evidence].slice(-evidenceLimit),
    updatedAt: outcome.observedAt,
  }
  const assessments = previous
    ? model.assessments.map(item => item.key === assessment.key ? assessment : item)
    : [...model.assessments, assessment]
  const nextModel = { assessments }

  return { prediction, outcome, evidence, assessment, model: nextModel }
}

/** Renders evidence-backed assessments for the next model request. */
export function renderSelfModelContext(assessments: readonly SelfAssessment[], limit = 6): string {
  const grounded = assessments
    .filter(assessment => assessment.supportCount + assessment.contradictionCount > 0)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(0, limit))
  if (grounded.length === 0)
    return ''

  return [
    'Self knowledge from recorded outcomes. Evidence balance is not a calibrated probability. Current mood and energy are temporary states.',
    ...grounded.map((assessment) => {
      const evidenceBalance = Math.round(assessment.evidenceBalance * 100)
      return `- ${assessment.claim} Evidence balance: ${evidenceBalance}%. Supporting outcomes: ${assessment.supportCount}. Contradicting outcomes: ${assessment.contradictionCount}.`
    }),
  ].join('\n')
}

/** Restores the newest assessment for each claim from Castalia search results. */
export function restoreSelfModel(records: readonly CastaliaSelfMemoryRecord[]): SelfModel {
  const assessments = new Map<string, SelfAssessment>()
  const ordered = [...records].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  for (const record of ordered) {
    const assessment = parseCastaliaSelfMemory(record)
    if (assessment)
      assessments.set(assessment.key, assessment)
  }
  return { assessments: [...assessments.values()] }
}

/** Maps reviewed evidence to Castalia's existing memory schema. */
export function toCastaliaSelfMemory(review: SelfReview): CastaliaSelfMemory {
  const { assessment, evidence } = review
  const text = JSON.stringify({
    kind: 'self-model-evidence',
    key: assessment.key,
    claim: assessment.claim,
    evidenceBalance: assessment.evidenceBalance,
    supportCount: assessment.supportCount,
    contradictionCount: assessment.contradictionCount,
    updatedAt: assessment.updatedAt,
    latestEvidence: evidence,
  })
  return {
    text,
    type: 'episodic',
    memType: 'project',
    category: 'self_model_evidence',
    ...(review.outcome.affect?.mood === undefined ? {} : { emotionalImpact: Math.abs(review.outcome.affect.mood) }),
    tags: ['self-model', assessment.key, evidence.polarity],
    importance: 0.6,
    tier: 'standard',
    source: 'airi:self-model',
    subject: 'self',
    skipEmbed: false,
  }
}

function validateAffectiveContext(affect?: AffectiveContext): void {
  if (affect?.mood !== undefined && (!Number.isFinite(affect.mood) || affect.mood < -10 || affect.mood > 10))
    throw new Error('Castalia mood must be between -10 and 10.')
  if (affect?.energy !== undefined && (!Number.isFinite(affect.energy) || affect.energy < 0 || affect.energy > 100))
    throw new Error('Castalia energy must be between 0 and 100.')
  const vad = affect?.vad
  if (vad && Object.values(vad).some(value => !Number.isFinite(value) || value < -1 || value > 1))
    throw new Error('Castalia VAD values must be between -1 and 1.')
}

function formatAffectiveContext(affect?: AffectiveContext): string {
  if (!affect)
    return ''

  const parts: string[] = []
  if (affect.mood !== undefined)
    parts.push(`mood ${affect.mood}`)
  if (affect.energy !== undefined)
    parts.push(`energy ${affect.energy}`)
  if (affect.desire?.trim())
    parts.push(`desire ${affect.desire.trim()}`)
  if (affect.vad)
    parts.push(`VAD ${affect.vad.valence}/${affect.vad.arousal}/${affect.vad.dominance}`)
  return parts.length > 0 ? `Affective context: ${parts.join(', ')}.` : ''
}

function parseCastaliaSelfMemory(record: CastaliaSelfMemoryRecord): SelfAssessment | undefined {
  const recordTime = Date.parse(record.createdAt)
  if (!Number.isFinite(recordTime))
    return undefined

  try {
    const value: unknown = JSON.parse(record.text)
    if (!isRecord(value) || value.kind !== 'self-model-evidence')
      return undefined
    if (typeof value.key !== 'string' || !value.key.trim() || typeof value.claim !== 'string' || !value.claim.trim())
      return undefined
    if (!isCount(value.supportCount) || !isCount(value.contradictionCount))
      return undefined
    if (typeof value.evidenceBalance !== 'number' || !Number.isFinite(value.evidenceBalance) || value.evidenceBalance < 0 || value.evidenceBalance > 1)
      return undefined
    if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || !isRecord(value.latestEvidence))
      return undefined

    const evidence = value.latestEvidence
    if (typeof evidence.id !== 'string' || typeof evidence.at !== 'number' || !Number.isFinite(evidence.at))
      return undefined
    if (evidence.polarity !== 'supports' && evidence.polarity !== 'contradicts')
      return undefined
    if (typeof evidence.summary !== 'string')
      return undefined

    return {
      key: value.key,
      claim: value.claim,
      evidenceBalance: value.evidenceBalance,
      supportCount: value.supportCount,
      contradictionCount: value.contradictionCount,
      evidence: [{
        id: evidence.id || record.id,
        at: evidence.at,
        polarity: evidence.polarity,
        summary: evidence.summary,
      }],
      updatedAt: value.updatedAt,
    }
  }
  catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
