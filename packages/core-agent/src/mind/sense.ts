/**
 * How the companion perceives the world.
 *
 * The mind never holds pixels. A sense turns whatever it can capture into one
 * line of text per observation, so a later vision model, a screen capture, or a
 * camera changes the adapter and nothing in the loop.
 *
 * NOTICE:
 * No sense is implemented yet. Screen capture exists in AIRI as a WebRTC
 * sharing surface (`@proj-airi/electron-screen-capture`), not as perception,
 * and there is no camera capture at all. The host attaches a port when one
 * exists; until then the companion is blind and behaves exactly as before.
 */

import type { PresenceReading } from './interruption'

export type SenseKind = 'screen' | 'camera' | 'window' | 'text'

export interface SenseObservation {
  kind: SenseKind
  /** One line. Already summarized; the mind never receives an image. */
  text: string
  /** When the host observed it. */
  at: number
  /**
   * Whether a word from the companion would be welcome right now.
   *
   * A host that can read the scene (the screen adapter asks the vision model
   * "what is this person doing") answers directly; when it is absent the mind
   * falls back to its own keyword read. Undefined is not "free" — it is "no
   * opinion", and the caller decides.
   */
  interruptible?: boolean
  /** Why, when the host has an opinion. */
  reason?: string
}

export interface SensePort {
  /** What the companion can perceive right now. Empty when nothing is available or allowed. */
  look: () => Promise<SenseObservation[]>
  /**
   * 廉价的一路：主人此刻在不在电脑前。
   *
   * 它不耗模型，所以每次 tick 都能问一次；`look` 要起截图和视觉调用，只在她打算
   * 开口、或者每五分钟一次的扫视里跑。缺了这一路，「不知道」就只能靠视觉猜，
   * 而视觉失败时她会把「不知道」当成「不忙」，开口就是一句「你在忙吗」。
   */
  presence?: () => Promise<PresenceReading>
  /**
   * What happened on the last look.
   *
   * A blind sense returns [] for permission, capture, and model failures alike, so
   * "she sees nothing" and "she is broken" look identical from outside. A port that
   * can explain itself makes that distinguishable without a debugger.
   */
  diagnostics?: () => Record<string, unknown>
}

/** A companion with no eyes and no webcam. The default. */
export const blindSense: SensePort = {
  look: async () => [],
}

export interface SenseDigest {
  /** Observations worth thinking about, newest last. */
  texts: string[]
  /** True when at least one observation had not been seen recently. */
  novel: boolean
  /** The observations that were new. */
  fresh: SenseObservation[]
}

/**
 * Compares what the sense returned with what the companion already saw.
 *
 * Novelty is what raises curiosity, so a static desktop must not keep counting
 * as new. The caller passes the texts it already holds, oldest first.
 */
export function digestSense(
  observations: SenseObservation[],
  seenTexts: string[],
): SenseDigest {
  const seen = new Set(seenTexts)
  const fresh = observations.filter(observation => observation.text.trim() && !seen.has(observation.text))
  return {
    texts: fresh.map(observation => observation.text),
    novel: fresh.length > 0,
    fresh,
  }
}
