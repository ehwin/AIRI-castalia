import type { ChatHistoryItem } from '@proj-airi/core-agent'

import type { AutonomyInput } from './speak-decision'

/** The drives that Castalia records for one persona. */
export interface DriveSnapshot {
  energy: number
  currentDesire: string | null
  /** Arousal from the recorded VAD, -1 to 1. Undefined when Castalia has no emotion yet. */
  arousal: number | undefined
}

export interface AdapterArgs {
  now: number
  lastSpokeAt: number | null
  messages: ChatHistoryItem[] | undefined
  snapshot: DriveSnapshot
  /** Relationship stage, 1 to 4. Undefined means no stored relationship. */
  relationshipStage: number | undefined
}

/**
 * Time of the last message that the owner wrote.
 *
 * A notice carries text for the conversation, but the owner did not write it, so
 * it never counts as the owner speaking.
 */
export function lastOwnerMessageAt(messages: ChatHistoryItem[] | undefined): number | null {
  if (!messages) {
    return null
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'user' || message.notice) {
      continue
    }
    const at = message.createdAt
    if (typeof at === 'number' && Number.isFinite(at)) {
      return at
    }
  }

  return null
}

/** Fills the drives that Castalia does not have yet with neutral values. */
export function toAutonomyInput(args: AdapterArgs): AutonomyInput {
  return {
    now: args.now,
    lastSpokeAt: args.lastSpokeAt,
    lastUserAt: lastOwnerMessageAt(args.messages),
    energy: args.snapshot.energy,
    desire: args.snapshot.currentDesire ?? '',
    arousal: args.snapshot.arousal ?? 0,
    relationshipDepth: args.relationshipStage ?? 1,
  }
}

/** The notice text that starts a self-initiated turn. */
export const SELF_INITIATED_NOTICE = [
  'A quiet moment passed. Act on your own only if you have something to say or do. Stay silent otherwise.',
  // 弱模型最容易在这里退回「你在忙吗」：那是把不确定推给主人。她刚看过屏幕（或
  // 至少知道自己没看见），所以这一问要么多余，要么该由感知来回答。
  'You already looked at the owner\'s screen. If you saw they are free, say what you wanted. If you could not see, do not ask whether they are busy.',
].join('\n')

/** The notice source that marks the stored turn. */
export const SELF_INITIATED_SOURCE = 'self-initiated-speech'

/**
 * Topic key of the conversation as it stands now.
 *
 * The dedupe asks "did I already say this", and a fixed key made every silent stretch look like the same subject.
 * Reading the last real message makes the key follow the subject: a new subject is a new key, so she may speak about
 * it inside the dedupe window, while the same subject still waits its turn.
 */
export function conversationTopic(messages: ChatHistoryItem[] | undefined): string | null {
  if (!messages) {
    return null
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.notice || (message.role !== 'user' && message.role !== 'assistant')) {
      continue
    }
    const text = typeof message.content === 'string' ? message.content : ''
    const key = text.trim().toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 24)
    if (key) {
      return key
    }
  }
  return null
}

/**
 * Topic key of an utterance, scoped to one character.
 *
 * The outbound gate dedupes by topic. Without the scope, every character without a desire shares the single key
 * `idle`, so one character's idle line mutes every other character for the whole dedupe window.
 */
export function scopedTopic(personaId: string, desire: string | null | undefined): string {
  const key = String(desire ?? '').trim().toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  return `${personaId}:${key || 'idle'}`
}
