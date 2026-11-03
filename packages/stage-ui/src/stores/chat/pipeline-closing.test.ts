import { createRelationalPolicyContextProvider } from './context-providers/relational-policy'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useChatContextStore } from './context-store'

/**
 * The chain the closing instruction has to survive:
 *
 *   provider → ContextMessage → registry (ReplaceSelf) → snapshot → runtime-context entries
 *
 * Each link has its own test; this one runs them together against the store the runtime
 * actually reads, so a broken link cannot hide behind three green neighbours.
 *
 * The only step not exercised here is `chat-orchestrator-runtime.ts:1022-1028`, which turns
 * the snapshot into segments: it is two lines of mapping, and `render-provider-chat.test.ts`
 * already proves the segment reaches the provider request body.
 */
describe('relational policy through the context registry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps one closing entry for the turn, and drops it when the next turn is not a goodbye', () => {
    const context = useChatContextStore()
    const provider = createRelationalPolicyContextProvider()

    const closing = provider('session-1', { id: 'm1', text: '我去洗澡了，先不聊啦' }, 'persona-1')
    expect(closing).toBeDefined()
    context.ingestContextMessage(closing!)

    const afterClosing = Object.entries(context.activeContexts)
      .flatMap(([source, messages]) => messages.map(message => ({ source, text: message.text })))
    expect(afterClosing).toHaveLength(1)
    expect(afterClosing[0].text).toContain('ending the conversation')

    // Next turn: normal conversation. ReplaceSelf must leave exactly one entry behind,
    // otherwise the model would still see yesterday's "she is leaving" instruction.
    const normal = provider('session-1', { id: 'm2', text: '今天数学课讲函数渐近线' }, 'persona-1')
    expect(normal).toBeDefined()
    context.ingestContextMessage(normal!)

    const afterNormal = Object.entries(context.activeContexts)
      .flatMap(([source, messages]) => messages.map(message => ({ source, text: message.text })))
    expect(afterNormal).toHaveLength(1)
    expect(afterNormal[0].text).not.toContain('ending the conversation')
    expect(afterNormal[0].text).toContain('guidance for you')
  })
})
