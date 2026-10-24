/**
 * What the companion did while the screen was closed.
 *
 * A window that is the whole world is not a life. The mind keeps its own clock:
 * rest recovers fatigue, and the background lane may leave thoughts behind. On
 * return the companion speaks from that state, not from a greeting template.
 *
 * Source: Oz Project (Bates, 1992) argues that believability comes from the
 * character pursuing its own goals between interactions. The offline case is
 * the cheap half of that claim, so it lives here.
 */
import type { Drives } from '../mind/drives'
import type { Thought } from './inner-stream'

import { restDrives } from '../mind/drives'

export interface ReturnInput {
  /** Milliseconds since the companion last ran. */
  awayMs: number
  drives: Drives
  /** Thoughts the background lane recorded while away, oldest first. */
  journal: Thought[]
  hourOfDay: number
}

export interface ReturnConfig {
  /** Away this long counts as having slept. */
  sleepMs: number
}

export const defaultReturnConfig: ReturnConfig = {
  sleepMs: 4 * 3_600_000,
}

export interface ReturnReport {
  drives: Drives
  slept: boolean
  /**
   * The first thing the companion says, or `undefined` when it says nothing.
   *
   * An empty journal means nothing happened, and a companion with nothing to
   * say must not invent a greeting. Silence is a valid return.
   */
  opening?: string
}

export function planReturn(
  input: ReturnInput,
  config: ReturnConfig = defaultReturnConfig,
): ReturnReport {
  const drives = restDrives(input.drives, input.awayMs)
  const slept = input.awayMs >= config.sleepMs

  const latest = input.journal.at(-1)
  return {
    drives,
    slept,
    ...(latest ? { opening: latest.text } : {}),
  }
}
