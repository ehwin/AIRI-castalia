import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

/** Short on purpose: the renderer prints this id as the bullet label, so it reads as a note. */
const MEMORY_RECALL_CONTEXT_ID = 'recalled'

/**
 * How long one turn waits for the memory backend. A slow bank drops the block
 * instead of holding the reply back, because the block is an extra, not the answer.
 */
const RECALL_TIMEOUT_MS = 300

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
  recall: (query: string) => Promise<string>,
): (input: { text: string }) => Promise<ContextMessage | undefined> {
  return async ({ text }) => {
    if (!text.trim())
      return undefined
    const block = await withDeadline(recall(text), RECALL_TIMEOUT_MS)
    if (!block)
      return undefined
    return {
      id: nanoid(),
      contextId: MEMORY_RECALL_CONTEXT_ID,
      strategy: ContextUpdateStrategy.ReplaceSelf,
      metadata: {
        source: { id: MEMORY_RECALL_CONTEXT_ID },
      },
      text: block,
      createdAt: Date.now(),
    }
  }
}
