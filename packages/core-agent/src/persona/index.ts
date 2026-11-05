export type { ReturnConfig, ReturnInput, ReturnReport } from './absence'
export { defaultReturnConfig, planReturn } from './absence'
export type { LaneConfig, LaneInput } from './background-lane'
export { composeThought, defaultLaneConfig } from './background-lane'
export type { CrisisResource } from './crisis-resources'
export { CRISIS_RESOURCES, crisisResourceLines } from './crisis-resources'
export type { CrisisAuditRecord, CrisisCategory, CrisisWatch, CrisisWatchOptions } from './crisis-watch'
export { classifyCrisisText, createCrisisWatch, CRISIS_WATCH_DEFAULTS, IMMEDIATE_CRISIS_CATEGORIES } from './crisis-watch'
export type { DiaryEntry, DistillOptions } from './diary-distill'
export { distillDay } from './diary-distill'
export type { FrictionConfig, FrictionResult, PersonaTraits, RequestTraits, Stance } from './friction'
export { applyFriction, assessFriction, defaultFrictionConfig } from './friction'
export type { InnerStream, Thought, ThoughtVisibility } from './inner-stream'
export { createStream, markShared, recent, record, sharedRatio, surface } from './inner-stream'
export type { RefusalDecision, RefusalInput, RefusalPolicy, RefusalState } from './refusal-policy'
export { createRefusalState, defaultRefusalPolicy, evaluateRefusal } from './refusal-policy'
export type {
  BoundarySignal,
  ClosingSignal,
  DisclosureLevel,
  MeaningHypothesis,
  MeaningHypothesisCandidate,
  RelationalPolicy,
  RelationalPolicyInput,
  RelationalSignals,
  RelationshipState,
  SafetyLevel,
} from './relational-policy'
export { closingFromRun, createRelationalPolicy, inferRelationalSignals, looksLikeFarewell, nextClosingRun, renderRelationalPolicyContext, reviewMeaningHypotheses, updateRelationship } from './relational-policy'
export type { RelationshipEvidence, RelationshipGateDecision, RelationshipGatePolicy, RelationshipLevelRequirement, RelationshipStage } from './relationship-gate'
export { decideRelationshipStage, pruneEvidence, RELATIONSHIP_GATE_DEFAULTS } from './relationship-gate'
export type { RequestTraitsWithKind } from './request-traits'
export { inferRequestTraits } from './request-traits'
export type { RetentionCategory, RetentionHit, RetentionScan, RetentionVerdict, RetentionWatch, RetentionWatchOptions } from './retention-guard'
export { createRetentionWatch, normalizeForScan, RETENTION_PATTERNS, RETENTION_WATCH_DEFAULTS, scanRetention } from './retention-guard'
export type {
  AffectiveContext,
  CastaliaAgentState,
  CastaliaSelfMemory,
  CastaliaSelfMemoryRecord,
  EvidencePolarity,
  SelfAssessment,
  SelfEvidence,
  SelfModel,
  SelfOutcome,
  SelfPrediction,
  SelfReview,
} from './self-model'
export {
  affectFromCastalia,
  createSelfModel,
  renderSelfModelContext,
  restoreSelfModel,
  reviewSelfPrediction,
  toCastaliaSelfMemory,
} from './self-model'
export type { StateLineInput } from './state-line'
export { renderStateLine } from './state-line'
