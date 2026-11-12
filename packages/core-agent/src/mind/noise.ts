/**
 * The impure input the loop is allowed to have: noise.
 *
 * A deterministic loop runs the same day twice. Boredom crosses 60 at the same
 * minute, she always thinks before she asks, and every day opens with the same
 * threshold — nothing about her is ever a surprise, so nothing she does reads as
 * a mood. Real affect carries variability of its own: the Ornstein–Uhlenbeck
 * model behind diary studies fits a diffusion term next to the home base and the
 * attractor strength, so the wobble is a property of the process rather than an
 * error to remove (Oravecz, Tuerlinckx & Vandekerckhove 2011; Kuppens, Oravecz &
 * Tuerlinckx 2010). Appraisal models that add chance to the decision report the
 * same motivation: believability and uncertainty (Kim et al. 2009, stochastic
 * OCC).
 *
 * Three kinds, in order of how much they are worth:
 *
 * 1. `stepWobble` — a slow, mean-reverting offset on the two attention drives.
 *    Mean-reverting because white noise per tick would make her twitchy, and
 *    every draw is used by the same decision it moves.
 * 2. `dailyJitter` — one offset per day for the thresholds that make her act.
 *    Stable within a day and identical across windows and reloads, because it is
 *    derived from the date, not from a clock reading.
 * 3. The softmax in `decide` — near the think line, whether she investigates or
 *    asks first is a draw. Far from the line it stays certain, so a mood still
 *    reads as a mood.
 *
 * What noise must never touch: the interruption verdict (a wrong "free" costs the
 * owner twenty minutes, Horvitz 1999; Iqbal & Horvitz 2007), anything persisted
 * as a record (memory, affect, diary), and the idempotency of writes. Noise makes
 * her variable, not unreliable.
 */
import type { ActionThresholds, Drives } from './drives'

/** A value between 0 and 100. */
type Gauge = number

export interface NoiseConfig {
  /** Standard deviation of the wobble, in drive points. */
  sigma: number
  /** Time constant of the wobble: how long one deviation survives, in milliseconds. */
  tauMs: number
  /** Half-width of the per-day threshold offset, in drive points. */
  jitter: number
}

/**
 * Starting values.
 *
 * `sigma` 3.5 keeps the wobble inside ±10 points for almost every draw (three
 * standard deviations), which moves the moment boredom crosses a threshold by
 * four to five minutes — visible over a day, invisible inside one sentence.
 * `tauMs` 20 minutes is the scale of a mood rather than a thought: shorter and
 * the threshold crossing jitters second by second, longer and two characters
 * never differ.
 */
export const defaultNoiseConfig: NoiseConfig = {
  sigma: 3.5,
  tauMs: 20 * 60_000,
  jitter: 5,
}

/** Where the wobble sits right now, per axis, in drive points. */
export interface Wobble {
  boredom: number
  curiosity: number
  /** When this reading was taken. */
  at: number
}

export function stillWobble(at: number): Wobble {
  return { boredom: 0, curiosity: 0, at }
}

/**
 * Small deterministic PRNG (mulberry32).
 *
 * Deterministic on purpose: the same seed must replay a day, or no test can ask
 * "does noise change behaviour" without also asking "does it change it the same
 * way twice".
 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a, so a character name or a date string can seed a stream. */
export function seedFrom(text: string): number {
  let hash = 0x811C9DC5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** One standard normal draw (Box–Muller). */
export function gaussian(random: () => number): number {
  // `1 - random()` avoids log(0) when the source can return exactly 0.
  const u = 1 - random()
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * One Ornstein–Uhlenbeck step.
 *
 * `w' = w·e^(-dt/τ) + σ·sqrt(1 - e^(-2dt/τ))·N(0,1)`. The square-root factor is
 * what makes the stationary spread equal `sigma` no matter how long the step is:
 * a suspended laptop returns to a fresh draw instead of keeping yesterday's mood
 * at half strength.
 */
export function stepWobble(
  previous: Wobble,
  now: number,
  config: NoiseConfig = defaultNoiseConfig,
  random: () => number = Math.random,
): Wobble {
  const dt = Math.max(0, now - previous.at)
  if (dt === 0)
    return previous
  const decay = Math.exp(-dt / config.tauMs)
  const scale = config.sigma * Math.sqrt(1 - decay * decay)
  return {
    boredom: previous.boredom * decay + scale * gaussian(random),
    curiosity: previous.curiosity * decay + scale * gaussian(random),
    at: now,
  }
}

/**
 * The offset for one day.
 *
 * Derived from the character and the calendar day, so the same window, another
 * window, and a reload six hours later all land on the same number: she wakes up
 * as the same person she was at breakfast. No storage, because a date is already
 * a stable name for a day.
 */
export function dailyJitter(
  seedText: string,
  day: string,
  config: NoiseConfig = defaultNoiseConfig,
): number {
  const random = createRandom(seedFrom(`${seedText}\u0000${day}`))
  return (random() * 2 - 1) * config.jitter
}

/** The hour that starts a new day for the offset. Same boundary the diary uses. */
export const NOISE_DAY_START_HOUR = 4

/**
 * The day a moment belongs to.
 *
 * Shifted by four hours, so the offset changes while she is asleep. Taking the calendar date
 * meant a ten-point step at 00:00, and a step in a threshold is a step in behaviour: a wakeful
 * midnight could push her one point over the line in the minute it happened.
 */
export function noiseDayKey(now: number): string {
  const shifted = new Date(now - NOISE_DAY_START_HOUR * 3_600_000)
  return `${shifted.getFullYear()}-${shifted.getMonth() + 1}-${shifted.getDate()}`
}

/**
 * Applies the day's offset to the thresholds that make her act.
 *
 * Sleep and wake stay fixed: they are the safety valve, and a loose night means
 * maintenance runs at a different rate. `sleepIdleMs` stays fixed too — it is a
 * guard against sleeping mid-conversation, not a preference.
 */
export function jitteredThresholds(base: ActionThresholds, offset: number): ActionThresholds {
  const shift = (value: number) => clamp(value + offset, 1, 100)
  return {
    ...base,
    provoke: shift(base.provoke),
    think: shift(base.think),
    napBoredom: shift(base.napBoredom),
    napFatigue: shift(base.napFatigue),
  }
}

/** The drives as this moment feels them, wobble included. */
export function withWobble(drives: Drives, wobble: Wobble): Drives {
  return {
    ...drives,
    boredom: clamp(drives.boredom + wobble.boredom, 0, 100),
    curiosity: clamp(drives.curiosity + wobble.curiosity, 0, 100),
  }
}

function clamp(value: number, low: number, high: number): Gauge {
  return Math.min(high, Math.max(low, value))
}
