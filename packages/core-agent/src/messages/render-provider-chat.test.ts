import type { ProjectionEntry } from './turns'
import type { RawMessage } from './types'

import { describe, expect, it } from 'vitest'

import { renderProviderChatMessages } from './render-provider-chat'

describe('renderProviderChatMessages', () => {
  it('renders structured event messages into raw provider chat messages', () => {
    const entries: Array<ProjectionEntry | RawMessage> = [
      {
        role: 'system',
        content: 'system prompt',
      },
      {
        id: 'event-1',
        role: 'event',
        source: 'plugin:airi-plugin-game-chess',
        segments: [
          {
            type: 'instruction',
            text: 'Keep the reply short.',
            priority: 'critical',
          },
          {
            type: 'text',
            text: 'Chess update',
          },
          {
            type: 'tagged-text',
            tag: 'agent_spark_command_reaction',
            text: 'Move accepted.',
          },
          {
            type: 'domain-event',
            eventType: 'board-updated',
            payload: {
              fen: 'startpos',
            },
          },
          {
            type: 'state-snapshot',
            stateType: 'board',
            payload: {
              fen: 'startpos',
            },
          },
          {
            type: 'history-block',
            compacted: true,
            items: [
              {
                type: 'summary',
                text: 'Compacted history.',
                fromTurnIndex: 1,
                toTurnIndex: 3,
              },
              {
                type: 'turn',
                turnType: 'chess',
                turnIndex: 3,
                actor: 'assistant',
                action: {
                  kind: 'move-executed',
                  san: 'e5',
                },
              },
              {
                type: 'domain-event',
                eventType: 'board-updated',
                payload: {
                  fen: 'startpos',
                },
              },
            ],
          },
          {
            type: 'summary',
            text: 'Earlier turns compacted.',
            metadata: {
              span: 2,
            },
          },
          {
            type: 'reference',
            refType: 'turn',
            targetId: 'turn-2',
            note: 'Recent move',
          },
        ],
      },
    ]

    const rendered = renderProviderChatMessages({
      entries,
      mode: 'session-spark-notify',
    })

    expect(rendered).toHaveLength(2)
    expect(rendered[0].content).toBe('system prompt')
    expect(rendered[1].role).toBe('system')
    expect(rendered[1].content).toContain('Instruction [critical]:')
    expect(rendered[1].content).toContain('<agent_spark_command_reaction>Move accepted.</agent_spark_command_reaction>')
    expect(rendered[1].content).toContain('Domain event: board-updated')
    expect(rendered[1].content).toContain('State snapshot: board')
    expect(rendered[1].content).toContain('Summary:')
    expect(rendered[1].content).toContain('Reference: turn -> turn-2')
  })

  // The runtime attaches every provider context to the last user message as a
  // `runtime-context` segment. If that segment were dropped on the way to the wire,
  // the closing instruction would look connected and never reach the model.
  it('renders a runtime context block into the user message that goes to the provider', () => {
    const entries: Array<ProjectionEntry | RawMessage> = [
      {
        id: 'user-1',
        role: 'user',
        segments: [
          { type: 'text', text: '当然，得准备学习呢' },
          {
            type: 'runtime-context',
            entries: [
              { source: 'relational-policy', text: 'Relationship policy: the user is ending the conversation. This turn answers the goodbye and nothing else.' },
              { source: 'mind', text: 'Right now you feel calm and a little tired.' },
            ],
          },
        ],
      },
    ]

    const rendered = renderProviderChatMessages({ entries, mode: 'session-main' })

    expect(rendered).toHaveLength(1)
    expect(rendered[0].role).toBe('user')
    expect(rendered[0].content).toContain('当然，得准备学习呢')
    expect(rendered[0].content).toContain('[Context]')
    expect(rendered[0].content).toContain('relational-policy: Relationship policy: the user is ending the conversation')
    expect(rendered[0].content).toContain('mind: Right now you feel calm')
  })
})
