import type { ContextMessage, RelationshipState } from '@proj-airi/core-agent'

import { createRelationalPolicy, inferRelationalSignals, renderRelationalPolicyContext } from '@proj-airi/core-agent'
import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

/** Short on purpose: the renderer prints this id as the bullet label. */
const RELATIONAL_POLICY_CONTEXT_ID = 'relational-policy'
const STORAGE_PREFIX = 'castalia:relationship:'
/**
 * Bounds the per-session cache. An evicted session rebuilds from storage on its
 * next turn, so the depth survives the eviction.
 */
const MAX_TRACKED_TURNS = 64

interface TrackedTurn {
  messageId: string
  /** The persona this turn advanced. A turn never lends its depth to another. */
  ownerId: string
  relationship: RelationshipState
  text: string
}

function isRelationshipState(value: unknown): value is RelationshipState {
  if (typeof value !== 'object' || value === null)
    return false
  const state = value as Partial<RelationshipState>
  return (state.stage === 1 || state.stage === 2 || state.stage === 3 || state.stage === 4)
    && typeof state.disclosureSignals === 'number'
    && typeof state.boundarySignals === 'number'
    && typeof state.lastUpdatedAt === 'number'
}

/** Reads the stored depth for one persona. The autonomy layer reads the stage from here. */
export function readStoredRelationship(ownerId: string): RelationshipState | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${ownerId}`)
    if (!raw)
      return undefined
    const parsed: unknown = JSON.parse(raw)
    return isRelationshipState(parsed) ? parsed : undefined
  }
  catch {
    return undefined
  }
}

function writeStoredRelationship(ownerId: string, relationship: RelationshipState): void {
  try {
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${ownerId}`, JSON.stringify(relationship))
  }
  catch {
    // A full or blocked storage keeps the in-memory depth for this session.
  }
}

/**
 * Turns the relational policy into one context message per user turn.
 *
 * The policy changes every turn, so it stays out of the cacheable system prompt.
 * A user turn advances depth once. Later steps of the same turn reuse the text.
 * `ownerId` is the persona: its depth survives a reload and a new session.
 */
export function createRelationalPolicyContextProvider() {
  const turns = new Map<string, TrackedTurn>()

  return function createRelationalPolicyContext(
    sessionId: string,
    lastUser?: { id: string, text: string },
    ownerId: string = sessionId,
  ): ContextMessage | undefined {
    if (!lastUser?.id || !lastUser.text)
      return undefined

    let turn = turns.get(sessionId)
    // A new persona must not reuse the previous persona's turn, even when the
    // renderer sends the same user message id again.
    if (turn?.messageId !== lastUser.id || turn?.ownerId !== ownerId) {
      const policy = createRelationalPolicy({
        now: Date.now(),
        // The session cache only stands in for storage when the persona matches.
        // Storage is per persona, so a switch inside one session starts fresh.
        relationship: readStoredRelationship(ownerId)
          ?? (turn?.ownerId === ownerId ? turn.relationship : undefined),
        ...inferRelationalSignals(lastUser.text),
        candidateHypotheses: [],
      })
      turn = {
        messageId: lastUser.id,
        ownerId,
        relationship: policy.relationship,
        text: renderRelationalPolicyContext(policy),
      }
      turns.set(sessionId, turn)
      if (turns.size > MAX_TRACKED_TURNS) {
        const oldest = turns.keys().next()
        if (!oldest.done)
          turns.delete(oldest.value)
      }
      writeStoredRelationship(ownerId, policy.relationship)
    }

    return {
      id: nanoid(),
      contextId: RELATIONAL_POLICY_CONTEXT_ID,
      strategy: ContextUpdateStrategy.ReplaceSelf,
      metadata: {
        source: { id: RELATIONAL_POLICY_CONTEXT_ID },
      },
      text: turn.text,
      createdAt: Date.now(),
    }
  }
}
