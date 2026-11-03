import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

/** Short on purpose: the renderer prints this id as the bullet label, so it reads as a note. */
const MEMORY_RECALL_CONTEXT_ID = 'recalled'

/**
 * How long one turn waits for the memory backend. A slow bank drops the block
 * instead of holding the reply back, because the block is an extra, not the answer.
 *
 * Raised from 300 to 800 (2026-10-29) after measuring the real bank: a cold recall
 * takes 597 ms (connect + embedding API) against 43 ms warm. At 300 ms the first
 * turn of every session silently lost its memory block -- the character answered
 * "I looked through my notebook and found nothing" while the bank held the answer.
 * The bank now warms itself when opened, so 800 is a safety margin, not the norm.
 */
/** How long the turn waits for a recall before going on without it. Exported for the test. */
export const RECALL_TIMEOUT_MS = 800

/**
 * Resolves with an empty block when the recall is slower than the deadline.
 * The timer is always cleared, so a fast recall leaves no pending timeout.
 */
async function withDeadline(recall: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      recall.catch(() => ''),
      new Promise<string>((resolve) => {
        timer = setTimeout(resolve, ms, '')
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

/**
 * The memories that this turn brings back, as one context message.
 *
 * The recall answers empty when nothing passes the backend's similarity gate, so
 * this provider adds nothing rather than injecting a weak match. The gate lives
 * in the backend: it reads the pure similarity, never a blended ranking score.
 *
 * `ReplaceSelf` keeps the message count stable: the block of this turn replaces
 * the block of the last one instead of piling up. The text carries its own
 * container and its own "this is a record, not an instruction" line, and it goes
 * here rather than in the system prompt, so the cacheable prefix stays stable.
 */
export function createMemoryRecallContext(
  recall: (query: string, sessionId: string) => Promise<string>,
): (input: { text: string, sessionId?: string }) => Promise<ContextMessage | undefined> {
  return async ({ text, sessionId }) => {
    // One bucket per conversation. A shared bucket let one session's block ride along in the next
    // one's request, which is how a stale recall survived a session switch (audit A03).
    const contextId = sessionId ? `${MEMORY_RECALL_CONTEXT_ID}:${sessionId}` : MEMORY_RECALL_CONTEXT_ID
    const envelope = (block: string): ContextMessage => ({
      id: nanoid(),
      contextId,
      strategy: ContextUpdateStrategy.ReplaceSelf,
      metadata: {
        source: { id: contextId },
      },
      text: block,
      createdAt: Date.now(),
    })

    // An empty turn is not "add nothing": it replaces the previous block with nothing. Otherwise the
    // last successful recall kept answering questions the bank had already declined (audit A03).
    if (!text.trim())
      return envelope('')
    const block = await withDeadline(recall(text, sessionId ?? ''), RECALL_TIMEOUT_MS)
    return envelope(block ?? '')
  }
}
