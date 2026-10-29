/**
 * Policies that decide when the character speaks without a user turn.
 *
 * Four policies answer the same question with different drive models. A policy
 * reads a snapshot of the drives that Castalia records, and reports both the
 * decision and the urge that produced it. The caller owns the clock, the drive
 * state, and the random source, so a test can replay one exact tick sequence.
 *
 * Every gate fails closed. A broken policy value or a non-finite drive refuses
 * speech instead of allowing it, because silence is the safe failure here.
 */

export interface AutonomyInput {
  /** Wall clock in milliseconds. */
  now: number
  /** Time of the last utterance, self-initiated or answering. Null means the session never spoke. */
  lastSpokeAt: number | null
  /** Time of the last owner message. Null means the session has no owner message. */
  lastUserAt: number | null
  /** Energy that Castalia records, 0 to 100. */
  energy: number
  /** Current unresolved desire. An empty string means no desire. */
  desire: string
  /** Arousal from the recorded VAD, -1 to 1. A negative value is calm, a positive value is excited. */
  arousal: number
  /** Relationship stage from the persona policy, 1 to 4. */
  relationshipDepth: number
}

export interface AutonomyPolicy {
  /** Nominal wait between two utterances at full energy, neutral arousal, and stage 1. */
  cooldownMs: number
  /** Energy at or below this value silences every policy. */
  energyFloor: number
  /** Chance of speaking in one tick once the interval passed, for speech without a desire. */
  baseChance: number
  /** Idle chatter waits this many times longer than speech backed by a desire, at stage 1. */
  idleChatterFactor: number
  /** Quiet time after an owner message, so the character never talks over the owner. */
  userGraceMs: number
  /** Random source. Tests inject a fixed sequence. */
  random: () => number
}

export type SpeakReason
  = | 'cooldown'
    | 'low-energy'
    | 'no-drive'
    | 'roll-lost'
    | 'speak'
    | 'user-recent'
    | 'input-invalid'
    | 'policy-invalid'

export interface SpeakDecision {
  speak: boolean
  /** Why the policy refused or accepted. Tests read this value. */
  reason: SpeakReason
  /** Normalized drive strength, 0 to 1. */
  urge: number
}

export type SpeakPolicy = (input: AutonomyInput, policy: AutonomyPolicy) => SpeakDecision

/** Starting values. The caller adds the random source. */
export const AUTONOMY_POLICY_DEFAULTS: Omit<AutonomyPolicy, 'random'> = {
  cooldownMs: 60_000,
  energyFloor: 20,
  baseChance: 0.3,
  idleChatterFactor: 3,
  userGraceMs: 20_000,
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return value > 0 ? 1 : 0
  }
  return clamp(value, 0, 1)
}

/** Maps a VAD arousal from -1..1 onto 0..1. The store saves the raw -1..1 value. */
function arousalUnit(value: number): number {
  return (clamp(value, -1, 1) + 1) / 2
}

/** Milliseconds since the last utterance. Infinity means the session never spoke. */
function idleMs(input: AutonomyInput): number {
  if (input.lastSpokeAt === null) {
    return Number.POSITIVE_INFINITY
  }
  return Math.max(0, input.now - input.lastSpokeAt)
}

function isFiniteInput(input: AutonomyInput): boolean {
  return Number.isFinite(input.now)
    && (input.lastSpokeAt === null || Number.isFinite(input.lastSpokeAt))
    && (input.lastUserAt === null || Number.isFinite(input.lastUserAt))
    && Number.isFinite(input.energy)
    && Number.isFinite(input.arousal)
    && Number.isFinite(input.relationshipDepth)
    && typeof input.desire === 'string'
}

/** A zero interval would divide the urge to Infinity and bypass the cooldown. */
function isSoundPolicy(policy: AutonomyPolicy): boolean {
  return Number.isFinite(policy.cooldownMs) && policy.cooldownMs > 0
    && Number.isFinite(policy.energyFloor)
    && Number.isFinite(policy.baseChance) && policy.baseChance > 0 && policy.baseChance <= 1
    && Number.isFinite(policy.idleChatterFactor) && policy.idleChatterFactor >= 1
    && Number.isFinite(policy.userGraceMs) && policy.userGraceMs >= 0
}

function refuse(reason: Exclude<SpeakReason, 'speak'>, urge: number): SpeakDecision {
  return { speak: false, reason, urge: clamp01(urge) }
}

function accept(urge: number): SpeakDecision {
  return { speak: true, reason: 'speak', urge: clamp01(urge) }
}

/** The gates that every policy shares, checked in one order. Returns null when every gate passes. */
function sharedRefusal(input: AutonomyInput, policy: AutonomyPolicy): SpeakDecision | null {
  if (!isFiniteInput(input)) {
    return refuse('input-invalid', 0)
  }
  if (!isSoundPolicy(policy)) {
    return refuse('policy-invalid', 0)
  }
  if (input.energy <= policy.energyFloor) {
    return refuse('low-energy', clamp01(input.energy / 100))
  }
  if (input.lastUserAt !== null && Math.max(0, input.now - input.lastUserAt) < policy.userGraceMs) {
    return refuse('user-recent', 0)
  }
  return null
}

/** Energy scales the wait below the nominal cooldown. Full energy keeps 1.0, empty keeps 0.5. */
function energyFactorOf(energy: number): number {
  return 0.5 + 0.5 * clamp01(energy / 100)
}

/** Arousal from 0..1 shortens the wait. A calm character keeps 1.0, an excited one reaches 2.0. */
function arousalFactorOf(arousal: number): number {
  return 1 + arousalUnit(arousal)
}

/** A deeper relationship shortens the wait. Stage 1 keeps 1.0, stage 4 reaches 1.45. */
function relationshipFactorOf(depth: number): number {
  return 1 + 0.15 * (clamp(depth, 1, 4) - 1)
}

/** Deeper relationships shorten idle chatter more than speech backed by a desire. */
function chatterFactorOf(hasDesire: boolean, policy: AutonomyPolicy, depth: number): number {
  if (hasDesire) {
    return 1
  }
  return Math.max(1, policy.idleChatterFactor - 0.5 * (clamp(depth, 1, 4) - 1))
}

/**
 * Speaks on a timer. Arousal shortens the wait, and the base chance decides the
 * tick. Simple and predictable, and it ignores the desire and the relationship.
 */
export function decideByIdleTimer(input: AutonomyInput, policy: AutonomyPolicy): SpeakDecision {
  const blocked = sharedRefusal(input, policy)
  if (blocked) {
    return blocked
  }

  const idle = idleMs(input)
  const urge = clamp01(idle / policy.cooldownMs)
  const effectiveCooldown = policy.cooldownMs * (1 - 0.4 * arousalUnit(input.arousal))

  if (idle < effectiveCooldown) {
    return refuse('cooldown', urge)
  }

  if (policy.random() >= policy.baseChance) {
    return refuse('roll-lost', urge)
  }

  return accept(urge)
}

/**
 * Speaks when an unresolved desire has built up enough pressure. Energy scales
 * the build-up rate, so a tired character needs longer. This policy never rolls
 * on the chance, because an unmet desire always becomes speech once it is full.
 */
export function decideByDesirePressure(input: AutonomyInput, policy: AutonomyPolicy): SpeakDecision {
  const blocked = sharedRefusal(input, policy)
  if (blocked) {
    return blocked
  }

  const hasDesire = input.desire.trim() !== ''
  const idle = idleMs(input)
  const intervalMs = policy.cooldownMs / energyFactorOf(input.energy)
  const urge = clamp01(idle / intervalMs)

  if (!hasDesire) {
    return refuse('no-drive', urge)
  }

  if (urge < 1) {
    return refuse('cooldown', urge)
  }

  return accept(urge)
}

/**
 * Speaks from spare capacity. Energy and arousal form the urge, and a desire
 * adds to it. A quiet character with low arousal and low energy stays silent
 * even after the cooldown, so idle chatter needs some drive behind it.
 */
export function decideByEnergyBudget(input: AutonomyInput, policy: AutonomyPolicy): SpeakDecision {
  const blocked = sharedRefusal(input, policy)
  if (blocked) {
    return blocked
  }

  const hasDesire = input.desire.trim() !== ''
  const idle = idleMs(input)
  const urge = clamp01(
    0.5 * clamp01(input.energy / 100)
    + 0.5 * arousalUnit(input.arousal)
    + (hasDesire ? 0.2 : 0),
  )

  if (idle < policy.cooldownMs) {
    return refuse('cooldown', urge)
  }

  if (!hasDesire && arousalUnit(input.arousal) < 0.25 && input.energy < 50) {
    return refuse('no-drive', urge)
  }

  if (policy.random() >= urge) {
    return refuse('roll-lost', urge)
  }

  return accept(urge)
}

/**
 * Speaks from a hybrid drive. Energy, arousal, and relationship depth set the
 * wait, so a tired character waits longer and an excited or familiar one waits
 * less. A desire removes the idle-chatter penalty; idle chatter also shrinks as
 * the relationship deepens.
 *
 * The interval carries the pace. Once the interval passes, every tick rolls
 * again, so the chance only shifts the exact tick by a few seconds.
 */
export function decideByHybridDrive(input: AutonomyInput, policy: AutonomyPolicy): SpeakDecision {
  const blocked = sharedRefusal(input, policy)
  if (blocked) {
    return blocked
  }

  const hasDesire = input.desire.trim() !== ''
  const idle = idleMs(input)
  const chatterFactor = chatterFactorOf(hasDesire, policy, input.relationshipDepth)
  const intervalMs = (policy.cooldownMs * chatterFactor)
    / (energyFactorOf(input.energy) * arousalFactorOf(input.arousal) * relationshipFactorOf(input.relationshipDepth))
  const urge = clamp01(idle / intervalMs)

  if (urge < 1) {
    return refuse('cooldown', urge)
  }

  const chance = hasDesire ? 1 : policy.baseChance
  if (chance < 1 && policy.random() >= chance) {
    return refuse('roll-lost', urge)
  }

  return accept(urge)
}

export const SPEAK_POLICIES = {
  'idle-timer': decideByIdleTimer,
  'desire-pressure': decideByDesirePressure,
  'energy-budget': decideByEnergyBudget,
  'hybrid-drive': decideByHybridDrive,
} satisfies Record<string, SpeakPolicy>

export type SpeakPolicyName = keyof typeof SPEAK_POLICIES

/** The policy that the runtime uses. The others stay for comparison and for the measurement test. */
export const ACTIVE_SPEAK_POLICY: SpeakPolicyName = 'hybrid-drive'
