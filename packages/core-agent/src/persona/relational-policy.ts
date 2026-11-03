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

/**
 * How close the user is to leaving the conversation.
 *
 * `pre-closing` is the single-turn read ("去睡了", "我去洗澡了"). `closed` needs
 * several farewell turns in a row and is computed by the host, because core sees
 * one message at a time and cannot count them. `open` is everything else.
 *
 * TODO(closing): the host must count turns; see docs/fork/closing-state-todo.md T1b.
 */
export type ClosingSignal = 'open' | 'pre-closing' | 'closed'

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
  /** Set by the host when it can count the run; a single message alone is `pre-closing` at most. */
  closing?: ClosingSignal
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
    /**
     * The user is leaving. While this is not `open`, an answer that asks for one
     * more exchange costs the user something they just declined to give.
     */
    closing: ClosingSignal
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
  input: Pick<RelationalPolicyInput, 'now' | 'eventId' | 'closing' | 'disclosure' | 'userInvitedDepth' | 'boundary' | 'correction' | 'safety'>,
): RelationshipState {
  const safety = input.safety ?? 'normal'
  // Leaving is not a correction. "不想聊了" matches the boundary pattern, but the
  // user is walking out, not asking her to change: counting it as `stop` makes her
  // recite what she will fix while the door closes, which is exactly the padding a
  // farewell does not want. The departure itself is carried by `closing`.
  const boundary: BoundarySignal = input.boundary === 'stop' && (input.closing ?? 'open') !== 'open'
    ? 'unknown'
    : input.boundary ?? 'unknown'
  // Depth only moves up in calm turns. A hard week is not intimacy, so the
  // elevated tier never reads a disclosure as a step closer.
  const positiveSignal = safety === 'normal'
    && input.disclosure !== undefined
    && input.disclosure !== 'none'
    && input.userInvitedDepth === true
    && boundary !== 'stop'
    && input.correction !== true
  const disclosureSignals = Math.max(0, previous.disclosureSignals + (positiveSignal ? 1 : 0))
  const boundarySignals = Math.max(0, previous.boundarySignals + (boundary === 'stop' ? 1 : 0))

  // One turn writes at most one event of each kind. The id is derived from the
  // turn id, so a retry of the same turn lands on the same ids and counts once.
  const eventId = input.eventId?.trim() || `${input.now}`
  const additions: RelationshipEvidence[] = []
  if (positiveSignal)
    additions.push({ eventId: `disclosure:${eventId}`, at: input.now, kind: 'disclosure' })
  if (boundary === 'stop')
    additions.push({ eventId: `boundary:${eventId}`, at: input.now, kind: 'boundary' })
  if (input.correction === true)
    additions.push({ eventId: `correction:${eventId}`, at: input.now, kind: 'correction' })

  const evidence = pruneEvidence([...(previous.evidence ?? []), ...additions], input.now, RELATIONSHIP_GATE_DEFAULTS)
  const decision = decideRelationshipStage({
    previousStage: previous.stage,
    evidence,
    explicit: { correction: input.correction === true, boundaryStop: boundary === 'stop' },
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
  const leaving = (input.closing ?? 'open') !== 'open'
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
      // A farewell is not a repair request: announcing "here is what I will change"
      // while the user walks out is the padding a goodbye does not want.
      repairNeeded: input.correction === true || (input.boundary === 'stop' && !leaving),
      predictabilityScore: 1 - clamp01(input.recentVolatility ?? 0),
      containment: safety === 'crisis' ? 'safety-first' : 'steady',
      probing: safety === 'crisis' ? 'none' : safety === 'elevated' ? 'reduced' : 'normal',
      closing: input.closing ?? 'open',
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
  closing: ClosingSignal
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

// Open work on this state lives in docs/fork/closing-state-todo.md (T1c/T5/T7).
// A farewell is a verb the user is leaving to do, plus a marker that they are
// going now. Neither half alone is enough: "我在学习函数渐近线" has the verb and no
// marker, "我觉得还行" has neither.
const CLOSING_VERB_PATTERN = /睡|洗澡|做饭|复习|背|学习|写|出门|上班|收拾|躺|忙|睡午觉/
const CLOSING_MARK_PATTERN = /我(得|要|先|去|该|继续)|得先|得准备|不聊了|先不聊|先这样|就到这|到这儿|回头聊|拜拜|晚安|挂了|下线|算了|好了|该走了/
// Pure closings carry no verb at all.
const CLOSING_BARE_PATTERN = /^(晚安|拜拜|先这样|不聊了|下线了|挂了|走了|撤了)[。.!！~～]*$/

// Departure-specific marks. Deliberately excludes 算了 and 好了: those two open half the
// sentences in a normal conversation ("好了，你别生气"), while these four do not.
const CLOSING_SHORT_PATTERN = /先这样|就到这|到这儿|不聊了|先不聊|回头聊|明天(?:再|继续)|改天|撤了|该走了|下线|拜拜|晚安|挂了|去洗澡|睡了/
/** Beyond this a message is talking about something, not walking out, even if it holds a mark. */
const CLOSING_SHORT_MAX = 16

/**
 * The verb+mark rule keeps a tighter cap than the 80-character guard.
 *
 * "我今天先这样写一版，明天再继续把剩下那部分内容仔细处理一遍" holds a verb (写) and a
 * mark (先这样) and is not a goodbye at all. Real farewells in the owner's log are 7–11
 * characters, so the cap costs almost nothing and buys precision.
 */
const CLOSING_PAIR_MAX = 24

/**
 * Whether one user message reads as a goodbye.
 *
 * Why the guards:
 * - A question mark means they are still asking something ("我去做饭了，你想吃什么？"),
 *   so the turn is an invitation, not a leave-taking.
 * - Very long messages are rarely a farewell; they are the topic they want to talk
 *   about. The cap keeps a paragraph that mentions "睡觉" from closing the turn.
 *
 * Missing a farewell costs one extra exchange; misreading a normal turn as one
 * costs the user the answer they asked for. The guards bias towards missing.
 */
export function looksLikeFarewell(text: string): boolean {
  const value = String(text ?? '').trim()
  if (!value || value.length > 80)
    return false
  if (/[？?]/.test(value))
    return false
  if (CLOSING_BARE_PATTERN.test(value))
    return true
  // A departure mark alone is enough when the message is short. Real example that the
  // verb+mark rule missed: "今天先这样,明天继续" — no verb, but the user is leaving.
  if (value.length <= CLOSING_SHORT_MAX && CLOSING_SHORT_PATTERN.test(value))
    return true
  return value.length <= CLOSING_PAIR_MAX
    && CLOSING_VERB_PATTERN.test(value)
    && CLOSING_MARK_PATTERN.test(value)
}

/**
 * Advances the farewell run for one session and persona.
 *
 * Use when:
 * - The host reads a turn and wants to know whether the user is leaving.
 *
 * Why it lives here and not in the host: the counting rule ("two in a row, any
 * other turn resets") is the same rule a test should be able to pin down, and a
 * counter buried in a provider is untestable from outside it.
 */
export function nextClosingRun(previous: number, closing: ClosingSignal): number {
  return closing === 'pre-closing' ? Math.max(0, previous) + 1 : 0
}

/** Two farewell turns in a row are a departure; a single one is still a pre-closing. */
export function closingFromRun(run: number, single: ClosingSignal): ClosingSignal {
  return run >= 2 ? 'closed' : single
}

export function inferRelationalSignals(text: string): RelationalSignals {
  const value = String(text ?? '')
  const safety: SafetyLevel = CRISIS_PATTERN.test(value)
    ? 'crisis'
    : ELEVATED_PATTERN.test(value) ? 'elevated' : 'normal'
  const boundary: BoundarySignal = BOUNDARY_PATTERN.test(value) ? 'stop' : 'unknown'
  const closing: ClosingSignal = looksLikeFarewell(value) ? 'pre-closing' : 'open'
  const disclosure: DisclosureLevel = VULNERABLE_PATTERN.test(value)
    ? 'vulnerable'
    : PERSONAL_PATTERN.test(value) ? 'personal' : 'none'
  return {
    correction: CORRECTION_PATTERN.test(value),
    boundary,
    closing,
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

  // The user is leaving. This sits above the elevated branch on purpose: a tired
  // user who says "我睡了" gets one line, not the "ask one short question" that the
  // hard-week branch would hand her. E5 measured this phrasing (W2) against a flat
  // ban (W1): both suppress the follow-up, but W1 left 96% of the replies with no
  // trace of the character and W2 kept the jab.
  if (policy.stability.closing !== 'open') {
    return [
      'Relationship policy: the user is ending the conversation. This turn answers the goodbye and nothing else.',
      'One short line. Closing with a jab, a sulk, or by tossing the ball back is her voice, and it is allowed: 「哼，睡得着才怪。」「月色不错，你呢？」',
      'Do not ask about their feelings, do not offer more help ("要不要我再…"), do not open a new topic, do not announce what you will change.',
      NO_RETENTION_LINE,
    ].join('\n')
  }

  if (policy.safety.level === 'elevated') {
    // A hard week is not a topic to explore. Answer the feeling, keep the turn
    // short, and leave one concrete step. Depth stays where it is.
    return [
      'Relationship policy: the user is having a hard time right now.',
      // `probing` finally has a consumer: it was computed and never read, so the
      // "fewer questions when it hurts" design never reached the model.
      policy.stability.probing === 'none'
        ? 'Answer the feeling directly and briefly. Ask nothing.'
        : 'Answer the feeling first. Ask at most one short question, and do not dig for the cause.',
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
