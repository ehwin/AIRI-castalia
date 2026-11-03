import type { GenerationProvider } from '@proj-airi/provider-inference'

import type { Conversation } from '../messages/types'
import type { ChatHistoryItem, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamOptions } from '../types/llm'
import type { ChatOrchestratorSessionPort } from './chat-orchestrator-runtime'

import { describe, expect, it, vi } from 'vitest'

import { createChatOrchestratorRuntime } from './chat-orchestrator-runtime'

const provider: GenerationProvider = {
  generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.com/' } }),
}

function userTurnTexts(conversation: Conversation): string[] {
  return conversation.turns.flatMap((turn) => {
    if (turn.type !== 'user')
      return []
    return turn.content
      .filter(segment => segment.type === 'text')
      .map(segment => (segment as { text: string }).text)
  })
}

describe('user turns carry a send-time prefix', () => {
  it('prefixes the current user turn with [YYYY-MM-DD HH:MM] in the provider request', async () => {
    const sessionMessages: ChatHistoryItem[] = []
    const conversations: Conversation[] = []
    const stream = vi.fn(async (_model: string, _chatProvider: GenerationProvider, messages: Conversation, options?: StreamOptions) => {
      conversations.push(messages)
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'assistant reply' })
      await options?.onStreamEvent?.({ type: 'finish' })
    })

    const runtime = createChatOrchestratorRuntime({
      session: {
        commitUserMessage: (async (_sessionId: string, message: ChatHistoryItem) => {
          sessionMessages.push(message)
          return { status: 'inserted' as const, messageId: message.id }
        }) as unknown as ChatOrchestratorSessionPort['commitUserMessage'],
        getSessionMessages: () => sessionMessages,
        commitAssistantMessage: async (_sessionId: string, message: ChatHistoryItem) => {
          sessionMessages.push(message)
        },
        getSessionGeneration: () => 1,
      },
      context: {
        ingest: vi.fn(),
        snapshot: (): Record<string, ContextMessage[]> => ({}),
      },
      foregroundStream: {
        patch: vi.fn(),
        reset: vi.fn(),
      },
      llm: { stream },
      getActiveSessionId: () => 'session-1',
      getActiveProvider: () => 'mock-provider',
      now: () => new Date(2026, 3, 25, 18, 47).getTime(),
      monotonicNow: () => 1000,
      createId: (() => {
        const ids = ['stream-context', 'assistant-id', 'user-id']
        return () => ids.shift() ?? 'generated'
      })(),
      onLifecycle: vi.fn(),
      onPromptProjection: vi.fn(),
      onUserMessageAppended: vi.fn(),
      onAssistantMessageAppended: vi.fn(),
      onUserTurnReady: vi.fn(),
      onAssistantTurnReady: vi.fn(),
      onStateChange: vi.fn(),
      onSendSettled: vi.fn(),
      onChatActivationStarted: vi.fn(),
      onChatActivationSucceeded: vi.fn(),
      onChatActivationFailed: vi.fn(),
      onMessageSendStarted: vi.fn(),
      onLlmRequestStarted: vi.fn(),
      onLlmFirstToken: vi.fn(),
      onAssistantResponseRendered: vi.fn(),
      onLlmGeneration: vi.fn(),
      onMessageRound: vi.fn(),
      onMessageRoundFailed: vi.fn(),
    } as unknown as Parameters<typeof createChatOrchestratorRuntime>[0])

    await runtime.ingest('现在几点', { model: 'gpt-test', chatProvider: provider })

    expect(stream).toHaveBeenCalled()
    const texts = userTurnTexts(conversations[0]!)
    expect(texts.some(text => text.startsWith('[2026-04-25 18:47] '))).toBe(true)
    expect(texts.join('\n')).toContain('现在几点')
  })
})
