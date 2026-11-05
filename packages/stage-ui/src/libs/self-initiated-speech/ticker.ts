import type { AutonomyInput, AutonomyPolicy, SpeakDecision } from './speak-decision'

export interface TickerReadArgs {
  now: number
  lastSpokeAt: number | null
}

/**
 * The verdict of the last check before an utterance goes out.
 *
 * The ticker never reads the reason. It hands it to the caller, which records it
 * for the diagnostics page, so a silent companion can explain itself.
 */
export interface SpeechGateVerdict {
  allow: boolean
  reason: string
}

export interface SpeechTickerOptions {
  decide: (input: AutonomyInput, policy: AutonomyPolicy) => SpeakDecision
  policy: AutonomyPolicy
  now: () => number
  /**
   * Traffic control, asked after the policy accepted and before the ticker
   * commits the time of the utterance. A refusal costs nothing: the next tick
   * asks again, and the cooldown is not spent on a message that never went out.
   */
  gate?: (args: { now: number, decision: SpeakDecision }) => SpeechGateVerdict
  /** Called once per refusal, so the caller can record what held the message back. */
  onGated?: (verdict: SpeechGateVerdict) => void
  /**
   * Returns undefined when no persona or session is ready. It stays synchronous
   * so that one tick reads one consistent state.
   */
  readInput: (args: TickerReadArgs) => AutonomyInput | undefined
  speak: (decision: SpeakDecision) => void | Promise<void>
  tickMs?: number
  /**
   * How long one utterance may hold the loop.
   *
   * `speak` awaits a screen look and a model call. A promise that never settles used to stop every later
   * tick, so one stuck request silenced her until the app restarted. The guard gives the lock back and
   * records why, instead of trusting every dependency to return.
   */
  speakBudgetMs?: number
  /** Called when the budget ran out, so the caller can record it. */
  onStuck?: (info: { at: number }) => void
}

export interface SpeechTicker {
  start: () => void
  stop: () => void
  /** Runs one tick. Public so that a test can drive the loop without timers. */
  tick: () => SpeakDecision | undefined
  isRunning: () => boolean
  lastSpokeAt: () => number | null
}

/** One second is the shortest wait that still looks like a pause to a person. */
export const TICK_MS = 1000

/** One utterance may hold the loop this long before the loop takes itself back. */
export const SPEAK_BUDGET_MS = 120_000

/**
 * Runs the speak decision on a fixed tick.
 *
 * The ticker owns two things that the policy cannot know: the time of the last
 * utterance, and whether a send is still in flight. It never overlaps sends, so
 * a slow reply cannot queue a second one behind itself.
 */
export function createSpeechTicker(options: SpeechTickerOptions): SpeechTicker {
  const tickMs = options.tickMs ?? TICK_MS
  const speakBudgetMs = options.speakBudgetMs ?? SPEAK_BUDGET_MS
  let handle: ReturnType<typeof setInterval> | undefined
  let lastSpokeAt: number | null = null
  let sending = false

  function tick(): SpeakDecision | undefined {
    const now = options.now()
    const input = options.readInput({ now, lastSpokeAt })
    if (!input) {
      return undefined
    }

    const decision = options.decide(input, options.policy)
    if (!decision.speak || sending) {
      return decision
    }

    // A gate that throws refuses. Silence is the safe failure for a companion
    // that starts its own turns.
    let verdict: SpeechGateVerdict | undefined
    try {
      verdict = options.gate?.({ now, decision })
    }
    catch {
      verdict = { allow: false, reason: 'gate-error' }
    }
    if (verdict && !verdict.allow) {
      options.onGated?.(verdict)
      return decision
    }

    lastSpokeAt = now
    sending = true
    // A failed send must not stop the loop. The chat store records the send error itself.
    // A speak that throws before it returns never reaches .finally, so settle it here too.
    let guard: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      if (guard)
        clearTimeout(guard)
      guard = undefined
      sending = false
    }
    guard = setTimeout(() => {
      if (!sending)
        return
      settle()
      options.onStuck?.({ at: now })
    }, speakBudgetMs)
    try {
      void Promise.resolve(options.speak(decision))
        .catch(() => {})
        .finally(settle)
    }
    catch {
      settle()
    }
    return decision
  }

  return {
    start() {
      if (handle) {
        return
      }
      handle = setInterval(tick, tickMs)
    },
    stop() {
      if (!handle) {
        return
      }
      clearInterval(handle)
      handle = undefined
    },
    tick,
    isRunning: () => handle !== undefined,
    lastSpokeAt: () => lastSpokeAt,
  }
}
