/**
 * The turn loop.
 *
 * One turn is: the model may ask for tools, each result goes back, then the
 * model answers again. `step` decides what happens next and touches nothing.
 * `runTurn` carries out those decisions.
 *
 * Source: `integrations/satori-bot/src/core/loop/scheduler.ts` runs a similar
 * loop without a round cap. A model that keeps asking for tools runs forever
 * there. `maxRounds` is the hard stop this loop adds.
 */
import type { MemoryPort, ToolCall, ToolPort } from './ports'
import type { StepRecord } from './session-log'

import { emptyMemory } from './ports'

export type LoopMessage
  = | { role: 'user', content: string }
    | { role: 'assistant', content: string, toolCalls: ToolCall[] }
    | { role: 'tool', callId: string, content: string, failed?: boolean }

export interface LoopPolicy {
  /** Model calls allowed in one turn. */
  maxRounds: number
  /** Tool calls allowed in one turn, counted across rounds. */
  maxToolCalls: number
}

export const defaultLoopPolicy: LoopPolicy = {
  maxRounds: 6,
  maxToolCalls: 12,
}

export type LoopFinish = 'ok' | 'budget' | 'cancelled' | 'error'

export type LoopEvent
  = | { type: 'user-said', text: string }
    | { type: 'model-replied', text: string, toolCalls: ToolCall[] }
    | { type: 'tool-settled', callId: string, output: string }
    | { type: 'tool-failed', callId: string, error: string }
    | { type: 'request-header', model: string, tools: string[] }
    | { type: 'model-failed', error: string }
    | { type: 'cancelled' }

export interface LoopState {
  messages: LoopMessage[]
  rounds: number
  toolCalls: number
  pending: ToolCall[]
  finished?: LoopFinish
}

export type LoopEffect
  = | { type: 'call-model', messages: LoopMessage[] }
    | { type: 'run-tool', call: ToolCall }
    | { type: 'finish', reason: LoopFinish, messages: LoopMessage[] }

export function createState(): LoopState {
  return { messages: [], rounds: 0, toolCalls: 0, pending: [] }
}

function finish(state: LoopState, reason: LoopFinish): { state: LoopState, effects: LoopEffect[] } {
  return {
    state: { ...state, pending: [], finished: reason },
    effects: [{ type: 'finish', reason, messages: state.messages }],
  }
}

/**
 * Advances the loop by one event.
 *
 * The function is pure. It reads the state, applies the policy, and returns the
 * next state with the effects that follow. No clock, no randomness, no IO.
 */
export function step(
  state: LoopState,
  event: LoopEvent,
  policy: LoopPolicy = defaultLoopPolicy,
): { state: LoopState, effects: LoopEffect[] } {
  if (state.finished && event.type !== 'cancelled')
    return { state, effects: [] }

  switch (event.type) {
    // Configuration is recorded, not acted on. It exists so a replay can check
    // that the same model and tools produced this turn.
    case 'request-header':
      return { state, effects: [] }

    // A failed model call still owns a record. Dropping it would leave the turn
    // with no trace of what happened.
    case 'model-failed':
      return finish(state, 'error')

    case 'user-said': {
      const next: LoopState = {
        ...createState(),
        messages: [...state.messages, { role: 'user', content: event.text }],
      }
      return { state: next, effects: [{ type: 'call-model', messages: next.messages }] }
    }

    case 'model-replied': {
      const rounds = state.rounds + 1
      const messages: LoopMessage[] = [
        ...state.messages,
        { role: 'assistant', content: event.text, toolCalls: event.toolCalls },
      ]

      if (event.toolCalls.length === 0)
        return finish({ ...state, rounds, messages }, 'ok')

      const toolCalls = state.toolCalls + event.toolCalls.length
      const roundBudgetSpent = rounds >= policy.maxRounds
      const toolBudgetSpent = toolCalls > policy.maxToolCalls

      if (roundBudgetSpent || toolBudgetSpent)
        return finish({ ...state, rounds, messages, toolCalls }, 'budget')

      return {
        state: { ...state, rounds, messages, toolCalls, pending: event.toolCalls },
        effects: event.toolCalls.map(call => ({ type: 'run-tool' as const, call })),
      }
    }

    case 'tool-settled':
    case 'tool-failed': {
      const failed = event.type === 'tool-failed'
      const content = failed ? event.error : event.output
      const messages: LoopMessage[] = [
        ...state.messages,
        { role: 'tool', callId: event.callId, content, ...(failed ? { failed } : {}) },
      ]
      const pending = state.pending.filter(call => call.callId !== event.callId)
      const next: LoopState = { ...state, messages, pending }

      // Every tool of this round must settle before the model sees the results.
      return pending.length > 0
        ? { state: next, effects: [] }
        : { state: next, effects: [{ type: 'call-model', messages }] }
    }

    case 'cancelled':
      return finish(state, 'cancelled')
  }
}

export interface TurnDeps {
  /** The model name, recorded so a replay can tell which model produced this turn. */
  model?: string
  /** One model call. Returns the reply text and any tool calls the model asked for. */
  send: (messages: LoopMessage[], signal?: AbortSignal) => Promise<{ text: string, toolCalls: ToolCall[] }>
  tools: ToolPort[]
  memory?: MemoryPort
  policy?: LoopPolicy
  signal?: AbortSignal
  /** Called for every effect, so a host can trace or render the turn. */
  onEffect?: (effect: LoopEffect) => void
}

export interface TurnResult {
  state: LoopState
  /** The last assistant text of the turn. */
  text: string
  /** Every step of the turn, in order, so the turn can be replayed. */
  record: StepRecord[]
}

function lastAssistantText(messages: LoopMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.content)
      return message.content
  }
  return ''
}

/**
 * Runs one turn to completion.
 *
 * The driver only carries out effects. Every decision lives in `step`, so a
 * change of behaviour means a change to one pure function.
 *
 * NOTICE:
 * This loop is deliberately not a second orchestrator.
 * `runtime/chat-orchestrator-runtime.ts` and `runtime/llm-service.ts` already run
 * streaming turns with providers, rounds, and continuations. This loop exists
 * for one purpose: a provider-free turn with a hard round and tool budget, so it
 * can be replayed and tested without a model.
 * Add streaming, providers, or continuation handling here and the duplication
 * becomes real. Use `runtime/` for those instead.
 */
export async function runTurn(input: string, deps: TurnDeps): Promise<TurnResult> {
  const policy = deps.policy ?? defaultLoopPolicy
  const memory = deps.memory ?? emptyMemory
  const tools = new Map(deps.tools.map(tool => [tool.name, tool]))

  let state = createState()
  const record: StepRecord[] = []

  // What this turn ran with. Without it, a replay cannot tell a real match from
  // a coincidence where a different model happened to behave the same way.
  record.push({
    event: { type: 'request-header', model: deps.model ?? 'unknown', tools: deps.tools.map(tool => tool.name) },
    effects: [],
  })

  /** Every decision goes through here so the turn keeps its own log. */
  const advance = (current: LoopState, event: LoopEvent) => {
    const next = step(current, event, policy)
    // Copy: the driver consumes the live array with shift(), so a reference would be drained.
    record.push({ event, effects: [...next.effects] })
    return next
  }

  const started = advance(state, { type: 'user-said', text: input })
  state = started.state
  let effects = started.effects

  /** A cancel wins over a reply that arrived after the user interrupted. */
  const cancelIfAborted = (): boolean => {
    if (!deps.signal?.aborted)
      return false
    const cancelled = advance(state, { type: 'cancelled' })
    state = cancelled.state
    effects = cancelled.effects
    return true
  }

  while (effects.length > 0) {
    const effect = effects.shift()!

    deps.onEffect?.(effect)

    if (effect.type === 'finish') {
      state = { ...state, finished: effect.reason }
      const text = lastAssistantText(effect.messages)
      if (text)
        await memory.record({ text }).catch(() => {})
      return { state, text, record }
    }

    if (cancelIfAborted())
      continue

    if (effect.type === 'call-model') {
      let reply: { text: string, toolCalls: ToolCall[] }
      try {
        reply = await deps.send(effect.messages, deps.signal)
      }
      catch (error) {
        if (cancelIfAborted())
          continue
        // A failed call still owns a record, so the turn leaves a trace.
        const failed = advance(state, { type: 'model-failed', error: error instanceof Error ? error.message : String(error) })
        state = failed.state
        effects = failed.effects
        continue
      }
      if (cancelIfAborted())
        continue
      const next = advance(state, { type: 'model-replied', text: reply.text, toolCalls: reply.toolCalls })
      state = next.state
      effects = next.effects
      continue
    }

    if (effect.type === 'run-tool') {
      const tool = tools.get(effect.call.name)
      let event: LoopEvent
      if (!tool) {
        event = { type: 'tool-failed', callId: effect.call.callId, error: `Unknown tool: ${effect.call.name}` }
      }
      else {
        try {
          const output = await tool.run(effect.call.arguments, deps.signal)
          event = { type: 'tool-settled', callId: effect.call.callId, output }
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          event = { type: 'tool-failed', callId: effect.call.callId, error: message }
        }
      }
      const next = advance(state, event)
      state = next.state
      effects = [...next.effects, ...effects]
    }
  }

  return { state, text: lastAssistantText(state.messages), record }
}
