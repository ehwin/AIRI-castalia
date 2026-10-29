/**
 * Who speaks, and whether anyone should speak at all.
 *
 * A chat UI assumes the user talks and the companion answers. A companion
 * spends most of its time not answering. This module decides which of five
 * things happens at one moment:
 *
 * - `silence`     nothing. The default, and the most common outcome.
 * - `backchannel` a short sound while the user keeps talking. No model call.
 * - `reply`       the user addressed the companion.
 * - `initiate`    the companion starts. It has something it held back, or it
 *                 is bored enough and the gates allow it.
 * - `defer`       the companion wanted to speak and waits instead.
 *
 * Source: `DESIGN-mind-dual-loop.md` and `DECISION-loop-context.md`. The mind
 * layer decides whether the companion is willing. This decides what it does
 * about it, which is a different question.
 */
import type { Drives, Gates } from '../mind/drives'

export type SpeechAct = 'silence' | 'backchannel' | 'reply' | 'initiate' | 'defer'

export interface PresenceInput {
  now: number
  /** When the user last finished speaking. */
  lastUserAt: number
  /** The user is speaking right now. */
  userSpeaking: boolean
  /** How long the current user speech has lasted. */
  userSpeechMs: number
  /** The companion is speaking right now. */
  speaking: boolean
  /** The current user turn already has a reply. */
  answered: boolean
  gates: Gates
  drives: Drives
  /** The host computes this from `mayProvoke`, so the arbiter stays pure. */
  mayProvoke: boolean
  /** A thought the companion wanted to say earlier and did not. */
  pendingThought?: string
}

export interface PresenceConfig {
  /** How long after the user stops an unanswered turn still counts as new. */
  replyWindowMs: number
  /** How long the user must keep talking before a short sound feels natural. */
  backchannelAfterMs: number
  /** Boredom that makes the companion start a topic. */
  initiateBoredom: number
}

export const defaultPresenceConfig: PresenceConfig = {
  replyWindowMs: 12_000,
  backchannelAfterMs: 4_000,
  initiateBoredom: 60,
}

export interface PresenceDecision {
  act: SpeechAct
  /** Why this act, for logs and tests. Never shown to the user. */
  reason: string
}

/**
 * Picks one act for the current moment.
 *
 * Order matters. Talking over the user is never allowed, and answering a
 * direct question beats every spontaneous urge.
 */
export function decideAct(
  input: PresenceInput,
  config: PresenceConfig = defaultPresenceConfig,
): PresenceDecision {
  const { now, lastUserAt, userSpeaking, userSpeechMs, speaking, answered, gates, drives } = input

  // One voice at a time. Barge-in is handled by the voice layer, not here.
  if (speaking)
    return { act: 'silence', reason: 'already speaking' }

  if (userSpeaking) {
    const longEnough = userSpeechMs >= config.backchannelAfterMs
    return longEnough && gates.allowThink
      ? { act: 'backchannel', reason: 'user still talking' }
      : { act: 'silence', reason: 'listening' }
  }

  // A direct question wins over anything spontaneous.
  const unanswered = !answered && now - lastUserAt <= config.replyWindowMs
  if (unanswered)
    return { act: 'reply', reason: 'user addressed the companion' }

  const canStart = gates.allowProvoke && input.mayProvoke

  if (input.pendingThought && canStart)
    return { act: 'initiate', reason: 'held-back thought is still relevant' }

  if (drives.boredom >= config.initiateBoredom && canStart)
    return { act: 'initiate', reason: 'bored' }

  // The companion wanted to speak but the moment is wrong. Keep the thought.
  if (input.pendingThought)
    return { act: 'defer', reason: 'gates or cooldown blocked it' }

  return { act: 'silence', reason: 'nothing to do' }
}
