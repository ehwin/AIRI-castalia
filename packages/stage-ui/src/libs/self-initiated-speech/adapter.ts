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
export const SELF_INITIATED_NOTICE = 'A quiet moment passed. Act on your own only if you have something to say or do. Stay silent otherwise.'

/** The notice source that marks the stored turn. */
export const SELF_INITIATED_SOURCE = 'self-initiated-speech'
