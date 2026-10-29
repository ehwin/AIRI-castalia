/**
 * How long the companion waits before it makes a sound.
 *
 * A reply that lands in the same millisecond feels like a form submission. A
 * person takes a moment, and the moment varies. This shapes that pause without
 * hiding it behind a timer, so the delay is testable.
 *
 * Source: `DESIGN-mind-dual-loop.md`. The exact numbers are a starting point,
 * not a measurement.
 */
import type { SpeechAct } from './arbiter'

export interface TimingConfig {
  /** Base wait before a spoken answer. */
  replyBaseMs: number
  /** Extra wait, scaled by the jitter the caller passes. */
  replyJitterMs: number
  /** Base wait before a short sound. Much shorter, it is not a turn. */
  backchannelBaseMs: number
  backchannelJitterMs: number
  /** Base wait before the companion starts a topic. */
  initiateBaseMs: number
}

export const defaultTimingConfig: TimingConfig = {
  replyBaseMs: 320,
  replyJitterMs: 480,
  backchannelBaseMs: 120,
  backchannelJitterMs: 130,
  initiateBaseMs: 0,
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * Returns the wait before this act, in milliseconds.
 *
 * `jitter` must come from the caller, between 0 and 1. Keeping it outside makes
 * the function pure, so a test pins the exact delay.
 */
export function planDelay(
  act: SpeechAct,
  jitter: number,
  config: TimingConfig = defaultTimingConfig,
): number {
  const j = clamp01(jitter)

  switch (act) {
    case 'reply':
      return Math.round(config.replyBaseMs + j * config.replyJitterMs)
    case 'backchannel':
      return Math.round(config.backchannelBaseMs + j * config.backchannelJitterMs)
    case 'initiate':
      return Math.round(config.initiateBaseMs)
    case 'silence':
    case 'defer':
      return 0
  }
}
