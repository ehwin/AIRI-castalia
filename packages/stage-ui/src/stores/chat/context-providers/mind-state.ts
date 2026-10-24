import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

const MIND_STATE_CONTEXT_ID = 'system:airi-mind-state'

/**
 * The companion's state right now: tired, bored, holding something back.
 *
 * This goes in a context message, not the system prompt, because it changes
 * every turn. The system prompt is the cacheable prefix that every provider
 * prices the same way: OpenAI caches the longest common prefix, Anthropic caches
 * up to an explicit breakpoint, and Gemini caches a stable context. One changing
 * byte at the start of that prefix costs the whole prefix on every request.
 *
 * `ReplaceSelf` keeps the message count stable: the new state replaces the old
 * one instead of piling up a new context every send.
 */
export function createMindStateContext(stateLine: string): ContextMessage | undefined {
  if (!stateLine)
    return undefined

  return {
    id: nanoid(),
    contextId: MIND_STATE_CONTEXT_ID,
    strategy: ContextUpdateStrategy.ReplaceSelf,
    metadata: {
      source: { id: MIND_STATE_CONTEXT_ID },
    },
    text: stateLine,
    createdAt: Date.now(),
  }
}
