/**
 * The sleep half of the mind loop.
 *
 * `drives.ts` says when the companion is tired enough to lie down and how fast
 * fatigue falls while she sleeps. This module holds the bout itself: when it
 * started, how well it is going, and when it is over. It is pure and clockless
 * — the host passes `now` in — so a test can run seven days in a few
 * milliseconds and an app that is never shut down still gets a night.
 *
 * Why a bout and not a single flag: recovery must survive a restart mid-sleep.
 * A boolean plus `restDrives(awayMs)` cannot tell "slept for six hours" from
 * "was closed for six hours" and it cannot carry the quality of a failed
 * consolidation into the next tick.
 */
import type { DriveConfig, Drives } from './drives'

import { advanceDrives, defaultDriveConfig, sleepDrives } from './drives'

/** What the maintenance cycle reports, reduced to the parts sleep cares about. */
export interface SleepStageReport {
  reflectOk?: boolean
  consolidateOk?: boolean
  digestOk?: boolean
}

/**
 * Turns a maintenance report into a recovery rate.
 *
 * A missing report is not a failure: a host without a memory backend still
 * lets her sleep, just at half rate. A consolidation that failed is a lighter
 * sleep, so she stays down longer instead of waking up "rested" on paper.
 */
export function sleepQualityFrom(report?: SleepStageReport | null): number {
  if (!report)
    return 0.5
  let quality = 0.3
  if (report.reflectOk)
    quality += 0.4
  if (report.consolidateOk)
    quality += 0.2
  if (report.digestOk)
    quality += 0.1
  return Math.max(0, Math.min(1, quality))
}

export interface SleepClock {
  /** When the bout began. */
  startedAt: number
  /** The last time this clock was advanced; keeps ticks from double-counting. */
  lastAt: number
  /** Recovery rate, 0 to 1. A nap is worth less than a night. */
  quality: number
  /** Fatigue points recovered so far in this bout. Diagnostics only. */
  recovered: number
  /** The bout ends at or below this fatigue. */
  wakeAt: number
  /** Hard cap, so a failed bout cannot last forever. */
  maxMs: number
}

export interface BoutOptions {
  quality: number
  wakeAt: number
  maxMs: number
}

/** A night: full recovery, ended by the wake threshold. */
export const defaultSleepBout: Omit<BoutOptions, 'quality'> = {
  wakeAt: 20,
  maxMs: 10 * 3_600_000,
}

/**
 * A nap: a short doze, not a second night.
 *
 * It stops twelve points above wherever it started, so a nap at 60 ends around
 * 48 — she wakes up less tired, not rested. It never runs the maintenance
 * cycle, so it costs no tokens; that is the whole reason it exists.
 */
export const defaultNapBout: Omit<BoutOptions, 'quality' | 'wakeAt'> = {
  maxMs: 35 * 60_000,
}

export const NAP_QUALITY = 0.9
/** A nap lifts the gauge by this much, then stops. */
export const NAP_WAKE_GAP = 12
/** Time passing is itself a relief from boredom. */
export const NAP_BOREDOM_RELIEF_PER_MINUTE = 0.4

export function beginBout(now: number, options: BoutOptions): SleepClock {
  return {
    startedAt: now,
    lastAt: now,
    quality: Math.max(0, Math.min(1, options.quality)),
    recovered: 0,
    wakeAt: options.wakeAt,
    maxMs: Math.max(0, options.maxMs),
  }
}

export interface BoutStep {
  clock: SleepClock
  drives: Drives
}

/**
 * Advances one sleeping tick.
 *
 * It only moves the clock: whether the bout is over is `boutOver()`, so the
 * caller has one predicate instead of two half-rules. The caller must not also
 * add awake fatigue on this tick, or a night would never end.
 */
export function advanceBout(
  clock: SleepClock,
  drives: Drives,
  now: number,
  options: {
    driveConfig?: DriveConfig
    boredomReliefPerMinute?: number
  } = {},
): BoutStep {
  const driveConfig = options.driveConfig ?? defaultDriveConfig
  const elapsed = Math.max(0, now - clock.lastAt)
  const slept = sleepDrives(drives, elapsed, clock.quality, driveConfig)
  const relief = Math.max(0, options.boredomReliefPerMinute ?? 0) * (elapsed / 60_000)
  const boredom = Math.max(0, Math.min(100, slept.boredom - relief))

  return {
    clock: {
      ...clock,
      lastAt: now,
      recovered: clock.recovered + Math.max(0, drives.fatigue - slept.fatigue),
    },
    drives: { ...slept, boredom },
  }
}


/** A night ends below its wake threshold; a nap also ends on its cap. */
export function boutOver(clock: SleepClock, drives: Drives, now: number): boolean {
  return drives.fatigue <= clock.wakeAt || now - clock.startedAt >= clock.maxMs
}

export interface BoutGapStep extends BoutStep {
  /** The bout reached its wake threshold or its cap inside this gap. */
  closed: boolean
  /** Wall-clock time the bout actually ended at (never past `now`). */
  settledUntil: number
  /** Time after the bout that was settled as ordinary awake time. */
  awakeMs: number
}

/**
 * Settles a gap that may be longer than the bout.
 *
 * A tick is 45 s, but a restart or a suspended laptop can hand us two hours in
 * one call. Crediting the whole gap at the nap's rate turns a 35-minute doze
 * into a two-hour sleep; the bout has to stop at the first boundary — the wake
 * threshold or the cap — and the rest of the gap is time she was awake.
 */
export function settleBoutGap(
  clock: SleepClock,
  drives: Drives,
  now: number,
  options: {
    driveConfig?: DriveConfig
    boredomReliefPerMinute?: number
  } = {},
): BoutGapStep {
  const config = options.driveConfig ?? defaultDriveConfig
  const from = Math.max(clock.lastAt, clock.startedAt)
  const target = Math.max(from, now)
  const quality = Math.max(0, Math.min(1, clock.quality))
  const perMs = config.fatigueRecoverPerHour * quality / 3_600_000
  const toWake = perMs > 0 ? Math.max(0, (drives.fatigue - clock.wakeAt) / perMs) : Number.POSITIVE_INFINITY
  const capAt = clock.startedAt + clock.maxMs
  const end = Math.min(target, capAt, from + toWake)

  const stepped = advanceBout(clock, drives, end, options)
  const closed = boutOver(stepped.clock, stepped.drives, end)
  let next = stepped.drives
  let awakeMs = 0
  if (closed && end < target) {
    awakeMs = target - end
    next = advanceDrives(next, awakeMs, {
      idleMs: Number.MAX_SAFE_INTEGER,
      fullscreen: false,
      micActive: false,
      hourOfDay: new Date(target).getHours(),
      novelty: false,
    }, config)
  }
  return { ...stepped, drives: next, closed, settledUntil: end, awakeMs }
}