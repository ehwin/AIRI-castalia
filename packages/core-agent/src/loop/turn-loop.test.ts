import { describe, expect, it, vi } from 'vitest'

import type { ToolPort } from './ports'

import { createState, defaultLoopPolicy, runTurn, step } from './turn-loop'

const call = (callId: string, name = 'lookup') => ({ callId, name, arguments: '{}' })

describe('step', () => {
  it('asks the model once after the user speaks', () => {
    const { state, effects } = step(createState(), { type: 'user-said', text: 'hi' })
    expect(state.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(effects).toEqual([{ type: 'call-model', messages: state.messages }])
  })

  it('finishes when the model answers without tools', () => {
    const started = step(createState(), { type: 'user-said', text: 'hi' })
    const { state, effects } = step(started.state, { type: 'model-replied', text: 'hello', toolCalls: [] })
    expect(state.finished).toBe('ok')
    expect(effects[0]).toMatchObject({ type: 'finish', reason: 'ok' })
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'hello' })
  })

  it('runs every tool of one round', () => {
    const started = step(createState(), { type: 'user-said', text: 'hi' })
    const { state, effects } = step(started.state, {
      type: 'model-replied',
      text: '',
      toolCalls: [call('a'), call('b')],
    })
    expect(state.pending).toHaveLength(2)
    expect(effects).toEqual([
      { type: 'run-tool', call: call('a') },
      { type: 'run-tool', call: call('b') },
    ])
  })

  it('waits for every tool before calling the model again', () => {
    const started = step(createState(), { type: 'user-said', text: 'hi' })
    const round = step(started.state, { type: 'model-replied', text: '', toolCalls: [call('a'), call('b')] })

    const first = step(round.state, { type: 'tool-settled', callId: 'a', output: 'A' })
    expect(first.effects).toEqual([])

    const second = step(first.state, { type: 'tool-settled', callId: 'b', output: 'B' })
    expect(second.effects[0]).toMatchObject({ type: 'call-model' })
    expect(second.state.messages.filter(message => message.role === 'tool')).toHaveLength(2)
  })

  it('stops when the round budget runs out, even while tools are pending', () => {
    const policy = { maxRounds: 2, maxToolCalls: 99 }
    const started = step(createState(), { type: 'user-said', text: 'hi' }, policy)
    const round1 = step(started.state, { type: 'model-replied', text: '', toolCalls: [call('a')] }, policy)
    const settled = step(round1.state, { type: 'tool-settled', callId: 'a', output: 'A' }, policy)
    const round2 = step(settled.state, { type: 'model-replied', text: '', toolCalls: [call('b')] }, policy)

    expect(round2.state.finished).toBe('budget')
    expect(round2.effects[0]).toMatchObject({ type: 'finish', reason: 'budget' })
  })

  it('stops when the tool call budget runs out', () => {
    const policy = { maxRounds: 99, maxToolCalls: 2 }
    const started = step(createState(), { type: 'user-said', text: 'hi' }, policy)
    const { state } = step(started.state, {
      type: 'model-replied',
      text: '',
      toolCalls: [call('a'), call('b'), call('c')],
    }, policy)
    expect(state.finished).toBe('budget')
  })

  it('stops on cancel', () => {
    const started = step(createState(), { type: 'user-said', text: 'hi' })
    const { state, effects } = step(started.state, { type: 'cancelled' })
    expect(state.finished).toBe('cancelled')
    expect(effects[0]).toMatchObject({ type: 'finish', reason: 'cancelled' })
  })

  it('ignores events after the turn finished', () => {
    const started = step(createState(), { type: 'user-said', text: 'hi' })
    const done = step(started.state, { type: 'model-replied', text: 'ok', toolCalls: [] })
    const after = step(done.state, { type: 'model-replied', text: 'again', toolCalls: [] })
    expect(after.effects).toEqual([])
  })
})

const tool = (name: string, run: ToolPort['run']): ToolPort => ({ name, run })

describe('runTurn', () => {
  it('feeds a tool result back and answers on the second round', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('a')] })
      .mockResolvedValueOnce({ text: 'the answer is 42', toolCalls: [] })

    const result = await runTurn('question', {
      send,
      tools: [tool('lookup', async () => '42')],
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('the answer is 42')
    expect(result.state.finished).toBe('ok')
    const toolMessage = result.state.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({ callId: 'a', content: '42' })
  })

  it('lets the model see a tool failure instead of throwing', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('a')] })
      .mockResolvedValueOnce({ text: 'sorry', toolCalls: [] })

    const result = await runTurn('question', {
      send,
      tools: [tool('lookup', async () => { throw new Error('boom') })],
    })

    expect(result.text).toBe('sorry')
    const toolMessage = result.state.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({ failed: true, content: 'boom' })
  })

  it('reports an unknown tool without crashing', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('a', 'missing')] })
      .mockResolvedValueOnce({ text: 'ok', toolCalls: [] })

    const result = await runTurn('question', { send, tools: [] })
    const toolMessage = result.state.messages.find(message => message.role === 'tool')
    expect(toolMessage).toMatchObject({ failed: true })
  })

  it('stops a model that keeps asking for tools', async () => {
    // Source: the satori bot loop has no cap, so this model would run forever.
    const send = vi.fn().mockResolvedValue({ text: '', toolCalls: [call('a')] })

    const result = await runTurn('loop forever', {
      send,
      tools: [tool('lookup', async () => 'again')],
      policy: { maxRounds: 3, maxToolCalls: 99 },
    })

    expect(send).toHaveBeenCalledTimes(3)
    expect(result.state.finished).toBe('budget')
  })

  it('records the finished answer once', async () => {
    const record = vi.fn(async () => {})
    const send = vi.fn().mockResolvedValue({ text: 'done', toolCalls: [] })

    await runTurn('question', {
      send,
      tools: [],
      memory: { recall: async () => [], record },
    })

    expect(record).toHaveBeenCalledTimes(1)
    expect(record).toHaveBeenCalledWith({ text: 'done' })
  })

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    const send = vi.fn(async () => {
      controller.abort()
      return { text: 'partial', toolCalls: [] as ReturnType<typeof call>[] }
    })

    const result = await runTurn('question', { send, tools: [], signal: controller.signal })
    expect(result.state.finished).toBe('cancelled')
  })

  it('keeps the default policy when the host passes none', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [call('a')] })
      .mockResolvedValueOnce({ text: 'ok', toolCalls: [] })

    await runTurn('question', { send, tools: [tool('lookup', async () => 'x')] })
    expect(defaultLoopPolicy.maxRounds).toBe(6)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
