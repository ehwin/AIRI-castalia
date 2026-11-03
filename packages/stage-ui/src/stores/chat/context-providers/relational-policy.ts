import type { ContextMessage, RelationshipState } from '@proj-airi/core-agent'

import { closingFromRun, createCrisisWatch, createRelationalPolicy, inferRelationalSignals, nextClosingRun, renderRelationalPolicyContext } from '@proj-airi/core-agent'
import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { useContextObservabilityStore } from '../../devtools/context-observability'

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
  relationship: RelationshipState
  text: string
}

/**
 * One cache slot per session and persona. The persona lives in the key, so a
 * turn never lends its depth to another persona, and a switch back to a persona
 * that already counted this user turn reuses its slot instead of counting again.
 */
function turnKey(sessionId: string, ownerId: string): string {
  return `${sessionId}\u0000${ownerId}`
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
 * A user turn advances depth once per persona. Later steps of the same turn
 * reuse the text. `ownerId` is the persona: its depth survives a reload and a
 * new session.
 */
export function createRelationalPolicyContextProvider() {
  const turns = new Map<string, TrackedTurn>()
  /**
   * One crisis watch per session and persona.
   *
   * A single hard sentence is caught by the signals of that turn. A slow walk
   * into a bad place is not: three rough turns inside one evening only look like
   * a crisis when something counts them together, and that counter is here.
   */
  const watches = new Map<string, ReturnType<typeof createCrisisWatch>>()
  /**
   * Farewell turns in a row, per session and persona.
   *
   * One "我去洗澡了" is a pre-closing and could still be followed by another topic;
   * a second one in a row is someone leaving. Core sees one message at a time, so
   * the count has to live here. Any non-farewell turn resets it.
   */
  // TODO(closing): unit-test the run counting (two in a row → closed, any other
  // turn → reset, one messageId → one count). See docs/fork/closing-state-todo.md T1c.
  const closingRuns = new Map<string, number>()

  return function createRelationalPolicyContext(
    sessionId: string,
    lastUser?: { id: string, text: string },
    ownerId: string = sessionId,
  ): ContextMessage | undefined {
    // A blank turn (attachment only, or a gamepad input) has nothing to read:
    // building a policy for it would still advance the depth and write storage.
    if (!lastUser?.id || !lastUser.text.trim())
      return undefined

    let turn = turns.get(turnKey(sessionId, ownerId))
    // A new persona must not reuse the previous persona's turn, even when the
    // renderer sends the same user message id again. The key carries the persona.
    if (turn?.messageId !== lastUser.id) {
      const now = Date.now()
      const key = turnKey(sessionId, ownerId)
      const signals = inferRelationalSignals(lastUser.text)
      // Count the run here; core only gets the verdict.
      const runKey = turnKey(sessionId, ownerId)
      const closingRun = nextClosingRun(closingRuns.get(runKey) ?? 0, signals.closing)
      closingRuns.set(runKey, closingRun)
      const closing = closingFromRun(closingRun, signals.closing)
      const watch = watches.get(key) ?? createCrisisWatch()
      watches.set(key, watch)
      // The watch can lift a turn to safety-first, and it never lowers one that a
      // single sentence already called a crisis. It also keeps the audit record,
      // which carries categories and flags and never the words of the user.
      const audited = watch.observe({ text: lastUser.text, level: signals.safety, at: now })
      const safety = audited.level
      if (safety !== 'normal') {
        // NOTICE:
        // A provider can be built outside a pinia (unit probes), so the write is
        // guarded: diagnostics must never cost a turn.
        // Root cause: no pinia is active in that call shape.
        // Source: packages/stage-ui/src/stores/chat/context-providers.
        // Remove when every provider call site has an active pinia.
        try {
          useContextObservabilityStore().recordCrisisAudit({
            at: audited.at,
            level: audited.level,
            categories: audited.categories,
            resourcesOffered: audited.resourcesOffered,
            escalated: audited.escalated,
          })
        }
        catch {}
      }
      const policy = createRelationalPolicy({
        now,
        // The session cache only stands in for storage when the persona matches.
        // Storage is per persona, so a switch inside one session starts fresh.
        relationship: readStoredRelationship(ownerId) ?? turn?.relationship,
        // The message id is the event id: a replayed or retried turn of the same
        // user message never counts as a second step closer.
        eventId: lastUser.id,
        ...signals,
        closing,
        safety,
        candidateHypotheses: [],
      })
      turn = {
        messageId: lastUser.id,
        relationship: policy.relationship,
        text: renderRelationalPolicyContext(policy),
      }
      turns.set(key, turn)
      if (turns.size > MAX_TRACKED_TURNS) {
        const oldest = turns.keys().next()
        if (!oldest.done) {
          turns.delete(oldest.value)
          // The watch of an evicted session goes with it, so a stale run of rough
          // turns cannot escalate a later, unrelated conversation.
          closingRuns.delete(oldest.value)
          const evicted = oldest.value.split('\u0000')[0]
          for (const candidate of [...watches.keys()]) {
            if (candidate.startsWith(`${evicted}\u0000`))
              watches.delete(candidate)
          }
        }
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
