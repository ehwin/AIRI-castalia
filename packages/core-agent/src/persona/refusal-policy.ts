/**
 * When the companion may refuse, and when it must not.
 *
 * A companion that refuses is alive. A companion that refuses twice is a mule.
 * This policy keeps refusal rare, lets the owner override it by asking again,
 * and never refuses a question.
 *
 * NOTICE:
 * The retry and budget rules are a product judgement, not a model of anything.
 * Move them into settings when the owner can tune them.
 */
import type { Drives } from '../mind/drives'
import type { RequestTraitsWithKind } from './request-traits'

import { applyFriction, assessFriction } from './friction'

export interface RefusalPolicy {
  /** Asking again within this window counts as insisting. */
  insistWindowMs: number
  /** At most this many refusals in one rolling hour. */
  maxPerHour: number
}

export const defaultRefusalPolicy: RefusalPolicy = {
  insistWindowMs: 10 * 60_000,
  maxPerHour: 1,
}

export interface RefusalState {
  /** Times of recent refusals, newest last. */
  refusals: number[]
  /** Text key to the time it was refused, so a repeat can comply. */
  refusedKeys: Map<string, number>
}

export function createRefusalState(): RefusalState {
  return { refusals: [], refusedKeys: new Map() }
}

export interface RefusalInput {
  text: string
  traits: RequestTraitsWithKind
  persona: { tidiness: number, patience: number }
  drives: Drives
  now: number
}

export interface RefusalDecision {
  /** True when the companion hands the task off instead of doing it. It never means silence. */
  handoff: boolean
  /** What she says about it. A handoff always says something. */
  message?: string
  /** The original request, queued for whoever does the work. */
  task?: string
  reason: string
  drives: Drives
  state: RefusalState
}

/**
 * Keys the whole request, not a prefix.
 *
 * A prefix collides whenever two chores start with the same pasted block, and a
 * collision would read as "the owner asked again" when they asked something else.
 */
function keyOf(text: string) {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  let hash = 5381
  for (let index = 0; index < normalized.length; index++)
    hash = ((hash << 5) + hash + normalized.charCodeAt(index)) | 0
  return `${normalized.length}:${hash}`
}

/**
 * Decides one request.
 *
 * Order matters: insisting always wins, a question never refuses, and the
 * hourly budget turns a would-be refusal into a complaint.
 */
export function evaluateRefusal(
  state: RefusalState,
  input: RefusalInput,
  policy: RefusalPolicy = defaultRefusalPolicy,
): RefusalDecision {
  const { now, text, traits, persona, drives } = input
  const refusals = state.refusals.filter(at => now - at < 3_600_000)
  const refusedKeys = new Map([...state.refusedKeys].filter(([, at]) => now - at < policy.insistWindowMs))
  const key = keyOf(text)

  // The owner asked again. Comply, and forget the refusal so a third try is normal.
  if (refusedKeys.has(key)) {
    refusedKeys.delete(key)
    return { handoff: false, reason: 'insisted', drives, state: { refusals, refusedKeys } }
  }

  const friction = assessFriction(traits, persona, drives)

  if (friction.stance === 'accept')
    return { handoff: false, reason: 'willing', drives, state: { refusals, refusedKeys } }

  const complain = (reason: string): RefusalDecision => ({
    handoff: false,
    reason,
    drives: applyFriction(drives, friction),
    state: { refusals, refusedKeys },
  })

  if (friction.stance === 'grumble')
    return complain('grumbled')

  // Refusal needs a chore. A long or messy question is still a question.
  if (!traits.isChore)
    return complain('refused but it is not a chore')

  if (refusals.length >= policy.maxPerHour)
    return complain('refusal budget spent')

  refusedKeys.set(key, now)
  return {
    handoff: true,
    // She always says something. Handing the task off is work, not silence.
    message: `这活我不干，已经丢给工程师了。${friction.reason}。`,
    task: text,
    reason: 'handed off',
    drives: applyFriction(drives, friction),
    state: { refusals: [...refusals, now], refusedKeys },
  }
}
