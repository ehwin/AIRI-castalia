export type { ReturnConfig, ReturnInput, ReturnReport } from './absence'
export { defaultReturnConfig, planReturn } from './absence'
export type { LaneConfig, LaneInput } from './background-lane'
export { composeThought, defaultLaneConfig } from './background-lane'
export type { DiaryEntry, DistillOptions } from './diary-distill'
export { distillDay } from './diary-distill'
export type { FrictionConfig, FrictionResult, PersonaTraits, RequestTraits, Stance } from './friction'
export { applyFriction, assessFriction, defaultFrictionConfig } from './friction'
export type { InnerStream, Thought, ThoughtVisibility } from './inner-stream'
export { createStream, recent, record, sharedRatio, surface } from './inner-stream'
export type { RefusalDecision, RefusalInput, RefusalPolicy, RefusalState } from './refusal-policy'
export { createRefusalState, defaultRefusalPolicy, evaluateRefusal } from './refusal-policy'
export type {
  BoundarySignal,
  DisclosureLevel,
  MeaningHypothesis,
  MeaningHypothesisCandidate,
  RelationalPolicy,
  RelationalPolicyInput,
  RelationalSignals,
  RelationshipState,
  SafetyLevel,
} from './relational-policy'
export { createRelationalPolicy, inferRelationalSignals, renderRelationalPolicyContext, reviewMeaningHypotheses, updateRelationship } from './relational-policy'
export type { RequestTraitsWithKind } from './request-traits'
export { inferRequestTraits } from './request-traits'
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
