import type { ToolPort } from './ports'

import { describe, expect, it, vi } from 'vitest'

import { parseRecord, replay, serializeRecord } from './session-log'
import { runTurn } from './turn-loop'

const call = (callId: string, name = 'lookup') => ({ callId, name, arguments: '{}' })
const tool = (name: string, run: ToolPort['run']): ToolPort => ({ name, run })

describe('session log', () => {
  it('round-trips through newline-delimited JSON', () => {
    const records = [
      { event: { type: 'user-said' as const, text: 'hi' }, effects: [] },
      { event: { type: 'model-replied' as const, text: 'hello', toolCalls: [] }, effects: [] },
    ]
    const parsed = parseRecord(serializeRecord(records))
    expect(parsed).toEqual(records)
  })

  it('rejects a line that is not a step', () => {
    expect(() => parseRecord('{"nope":true}\n')).toThrow('Not a step record')
  })

  it('skips blank lines', () => {
    const text = `${JSON.stringify({ event: { type: 'cancelled' }, effects: [] })}\n\n`
    expect(parseRecord(text)).toHaveLength(1)
  })
})

describe('replay', () => {
  it('reproduces every effect of a tool turn', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('a')] })
      .mockResolvedValueOnce({ text: 'done', toolCalls: [] })

    const result = await runTurn('question', { send, tools: [tool('lookup', async () => '42')] })

    expect(result.record.length).toBeGreaterThan(0)
    expect(replay(result.record)).toMatchObject({ matches: true })
  })

  it('survives a serialize and parse before replaying', async () => {
    const send = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] })
    const result = await runTurn('question', { send, tools: [] })

    const restored = parseRecord(serializeRecord(result.record))
    expect(replay(restored).matches).toBe(true)
  })

  it('detects a tampered effect', async () => {
    const send = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] })
    const result = await runTurn('question', { send, tools: [] })

    const tampered = result.record.map((step, index) =>
      index === 0 ? { ...step, effects: [{ type: 'finish', reason: 'budget', messages: [] }] } : step)

    const replayed = replay(tampered as typeof result.record)
    expect(replayed.matches).toBe(false)
    expect(replayed.divergedAt).toBe(0)
  })

  it('replays a turn that ran out of budget', async () => {
    const send = vi.fn().mockResolvedValue({ text: '', toolCalls: [call('a')] })
    const result = await runTurn('loop forever', {
      send,
      tools: [tool('lookup', async () => 'again')],
      policy: { maxRounds: 3, maxToolCalls: 99 },
    })

    expect(result.state.finished).toBe('budget')
    expect(replay(result.record, { maxRounds: 3, maxToolCalls: 99 }).matches).toBe(true)
  })
})

describe('malformed tool calls', () => {
  it('records an unknown tool as a failure instead of throwing', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [{ callId: 'x', name: '', arguments: 'not json' }] })
      .mockResolvedValueOnce({ text: 'sorry', toolCalls: [] })

    const result = await runTurn('question', { send, tools: [] })

    expect(result.state.finished).toBe('ok')
    expect(result.text).toBe('sorry')
    const failed = result.record.find(step => step.event.type === 'tool-failed')
    expect(failed).toBeDefined()
    expect(replay(result.record).matches).toBe(true)
  })

  it('keeps a failed tool message in the derived history', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('x', 'missing')] })
      .mockResolvedValueOnce({ text: 'ok', toolCalls: [] })

    const result = await runTurn('question', { send, tools: [] })
    const toolMessage = result.state.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({ failed: true })
  })
})

describe('what the record keeps', () => {
  it('starts with the request header', async () => {
    const send = vi.fn().mockResolvedValue({ text: 'ok', toolCalls: [] })
    const result = await runTurn('question', {
      send,
      tools: [tool('lookup', async () => 'x')],
      model: 'local/qwen',
    })

    const header = result.record[0].event
    expect(header).toMatchObject({ type: 'request-header', model: 'local/qwen', tools: ['lookup'] })
    expect(replay(result.record).matches).toBe(true)
  })

  it('keeps a failed model call instead of losing the turn', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connection reset'))
    const result = await runTurn('question', { send, tools: [] })

    expect(result.state.finished).toBe('error')
    const failed = result.record.find(step => step.event.type === 'model-failed')
    expect(failed?.event).toMatchObject({ type: 'model-failed', error: 'connection reset' })
    expect(replay(result.record).matches).toBe(true)
  })

  it('records the failure after a successful first round', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('a')] })
      .mockRejectedValueOnce(new Error('rate limited'))

    const result = await runTurn('question', { send, tools: [tool('lookup', async () => '42')] })

    expect(result.state.finished).toBe('error')
    expect(result.record.some(step => step.event.type === 'tool-settled')).toBe(true)
    expect(replay(result.record).matches).toBe(true)
  })
})
