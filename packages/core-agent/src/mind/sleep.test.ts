import type { Drives } from './drives'
import type { SleepClock } from './sleep'

import { describe, expect, it } from 'vitest'

import { advanceDrives, decide, defaultActionThresholds, quietEnvironment } from './drives'
import {
  advanceBout,
  beginBout,
  boutOver,
  defaultNapBout,
  defaultSleepBout,
  NAP_BOREDOM_RELIEF_PER_MINUTE,
  NAP_QUALITY,
  NAP_WAKE_GAP,
  settleBoutGap,
  sleepQualityFrom,
} from './sleep'

const TICK = 45_000
const idle = (): Drives => ({ fatigue: 0, boredom: 0, curiosity: 0, focus: 0 })

/**
 * The host that never shuts down: one tick every 45 seconds, awake fatigue in
 * between, a bout when `decide` asks for one. This is the scenario the old code
 * could not survive — `restDrives` only ran on the away path, so the gauge
 * reached 80 and stayed there until the process was restarted.
 */
function runDays(days: number, quality = 1, start = new Date('2026-11-01T08:00:00').getTime()) {
  let now = start
  let drives = idle()
  let clock: SleepClock | null = null
  const bouts: Array<{ start: number, end: number, recovered: number }> = []
  let awakeTicks = 0
  let sleepTicks = 0

  const total = Math.round((days * 24 * 3_600_000) / TICK)
  for (let i = 0; i < total; i++) {
    now += TICK
    if (clock) {
      const step = advanceBout(clock, drives, now)
      clock = step.clock
      drives = step.drives
      sleepTicks++
      if (boutOver(clock, drives, now)) {
        bouts.push({ start: clock.startedAt, end: now, recovered: clock.recovered })
        clock = null
      }
      continue
    }

    drives = advanceDrives(drives, TICK, {
      ...quietEnvironment,
      idleMs: 0,
      hourOfDay: new Date(now).getHours(),
    })
    awakeTicks++
    if (decide(drives, undefined, { idleMs: 60 * 60_000 }) === 'sleep')
      clock = beginBout(now, { quality, ...defaultSleepBout })
  }

  return { drives, bouts, awakeTicks, sleepTicks, now, clock }
}

describe('sleepQualityFrom', () => {
  it('pays for the stages that actually ran', () => {
    expect(sleepQualityFrom(null)).toBe(0.5)
    expect(sleepQualityFrom({ reflectOk: true })).toBeCloseTo(0.7, 5)
    expect(sleepQualityFrom({ reflectOk: true, consolidateOk: true, digestOk: true })).toBeCloseTo(1, 6)
    expect(sleepQualityFrom({ reflectOk: false, consolidateOk: true })).toBeCloseTo(0.5, 5)
  })
})

describe('advanceBout', () => {
  it('never adds awake fatigue while asleep', () => {
    const start = { ...idle(), fatigue: 80 }
    const clock = beginBout(1_000, { quality: 1, ...defaultSleepBout })
    const step = advanceBout(clock, start, 1_000 + 3_600_000)
    expect(step.drives.fatigue).toBeCloseTo(67.5, 5)
    expect(boutOver(step.clock, step.drives, 1_000 + 3_600_000)).toBe(false)
  })

  it('ends a night at the wake threshold', () => {
    let clock = beginBout(0, { quality: 1, ...defaultSleepBout })
    let drives = { ...idle(), fatigue: 80 }
    let now = 0
    while (!boutOver(clock, drives, now)) {
      now += TICK
      const step = advanceBout(clock, drives, now)
      clock = step.clock
      drives = step.drives
    }
    expect(drives.fatigue).toBeLessThanOrEqual(defaultActionThresholds.wake + 0.5)
    expect(now).toBeGreaterThan(4 * 3_600_000)
  })

  it('caps a night even if the gauge never reaches the wake threshold', () => {
    // Quality 0.01 is the pathological case: the clock alone has to end it.
    const clock = beginBout(0, { quality: 0.01, ...defaultSleepBout })
    const later = defaultSleepBout.maxMs
    const step = advanceBout(clock, { ...idle(), fatigue: 100 }, later)
    expect(step.drives.fatigue).toBeGreaterThan(defaultActionThresholds.wake)
    expect(boutOver(step.clock, step.drives, later)).toBe(true)
  })
})

describe('a nap', () => {
  it('stops on its own cap and lifts the gauge only a little', () => {
    let clock = beginBout(0, {
      quality: NAP_QUALITY,
      wakeAt: 40 - NAP_WAKE_GAP,
      ...defaultNapBout,
    })
    let drives = { ...idle(), fatigue: 40, boredom: 90 }
    let now = 0
    while (!boutOver(clock, drives, now)) {
      now += TICK
      const step = advanceBout(clock, drives, now, {
        boredomReliefPerMinute: NAP_BOREDOM_RELIEF_PER_MINUTE,
      })
      clock = step.clock
      drives = step.drives
    }
    const minutes = (now - clock.startedAt) / 60_000
    expect(minutes).toBeLessThanOrEqual(36)
    expect(drives.fatigue).toBeGreaterThan(30)
    expect(drives.fatigue).toBeLessThan(40)
    // Time passing is relief: she does not wake up as bored as she lay down.
    expect(drives.boredom).toBeLessThan(80)
  })

  it('is not a night: a full battery still needs a real sleep', () => {
    const clock = beginBout(0, { quality: NAP_QUALITY, wakeAt: 0, ...defaultNapBout })
    const step = advanceBout(clock, { ...idle(), fatigue: 80 }, defaultNapBout.maxMs)
    expect(step.drives.fatigue).toBeGreaterThan(defaultActionThresholds.wake)
  })
})

describe('a week without a restart', () => {
  it('sleeps once a day and never sticks at the ceiling', () => {
    const { drives, bouts, awakeTicks, sleepTicks } = runDays(7)

    // A bout roughly every 18-24 hours: one night a day, not a coma and not insomnia.
    expect(bouts.length).toBeGreaterThanOrEqual(6)
    expect(bouts.length).toBeLessThanOrEqual(9)

    for (const bout of bouts) {
      const hours = (bout.end - bout.start) / 3_600_000
      expect(hours).toBeGreaterThan(3)
      expect(hours).toBeLessThan(8)
    }

    // She spends most of the week awake, but a real slice asleep.
    const sleepRatio = sleepTicks / (sleepTicks + awakeTicks)
    expect(sleepRatio).toBeGreaterThan(0.15)
    expect(sleepRatio).toBeLessThan(0.35)

    // The bug this replaces: fatigue reaching 100 and staying there.
    expect(drives.fatigue).toBeLessThan(defaultActionThresholds.sleep)
  })

  it('sleeps longer when the maintenance cycle failed', () => {
    const good = runDays(2, 1)
    const bad = runDays(2, 0.4)
    const hours = (r: ReturnType<typeof runDays>) => r.bouts.reduce((sum, b) => sum + (b.end - b.start), 0) / 3_600_000
    expect(hours(bad)).toBeGreaterThan(hours(good))
  })
})

describe('a restart mid-sleep', () => {
  it('resumes instead of refilling the battery', () => {
    const start = new Date('2026-11-01T23:00:00').getTime()
    const clock = beginBout(start, { quality: 1, ...defaultSleepBout })
    const drives = { ...idle(), fatigue: 80 }

    // Two hours of sleep, then the process dies.
    const afterTwo = advanceBout(clock, drives, start + 2 * 3_600_000)
    expect(afterTwo.drives.fatigue).toBeCloseTo(55, 5)

    // Same clock and drives, loaded from disk: an hour later she is lower,
    // not back at zero (a refill) and not still at 80 (a lost night).
    const resumed = advanceBout(afterTwo.clock, afterTwo.drives, start + 3 * 3_600_000)
    expect(resumed.drives.fatigue).toBeCloseTo(42.5, 5)
  })
})

describe('a gap longer than the bout', () => {
  const calm = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }

  it('stops a nap at its cap instead of sleeping the whole gap', () => {
    const t0 = 1_700_000_000_000
    const clock = beginBout(t0, { quality: 0.9, wakeAt: 60 - NAP_WAKE_GAP, maxMs: 35 * 60_000 })
    const step = settleBoutGap(clock, { ...calm, fatigue: 60 }, t0 + 2 * 3_600_000)

    // 35 min at 12.5/h × 0.9 = 6.5625 (60 → 53.4375), then 85 min awake at
    // 0.08/min (+6.8). The nap alone is checked by the same-length case below.
    expect(step.closed).toBe(true)
    expect(step.settledUntil).toBe(t0 + 35 * 60_000)
    expect(step.drives.fatigue).toBeCloseTo(60.2375, 3)
    expect(step.awakeMs).toBe(85 * 60_000)

    const exact = settleBoutGap(clock, { ...calm, fatigue: 60 }, t0 + 35 * 60_000)
    expect(exact.drives.fatigue).toBeCloseTo(53.4375, 3)
    expect(exact.awakeMs).toBe(0)
  })

  it('wakes a night at the threshold and settles the rest awake', () => {
    const t0 = 1_700_000_000_000
    const clock = beginBout(t0, { quality: 1, wakeAt: 20, maxMs: 10 * 3_600_000 })
    const step = settleBoutGap(clock, { ...calm, fatigue: 80 }, t0 + 6 * 3_600_000)

    expect(step.closed).toBe(true)
    expect(step.settledUntil).toBe(t0 + 4.8 * 3_600_000)
    expect(step.drives.fatigue).toBeCloseTo(25.76, 3)
  })

  it('does not invent awake time when the gap fits inside the bout', () => {
    const t0 = 1_700_000_000_000
    const clock = beginBout(t0, { quality: 1, wakeAt: 20, maxMs: 10 * 3_600_000 })
    const step = settleBoutGap(clock, { ...calm, fatigue: 80 }, t0 + 10 * 60_000)

    expect(step.closed).toBe(false)
    expect(step.awakeMs).toBe(0)
    expect(step.drives.fatigue).toBeCloseTo(80 - 10 * 12.5 / 60, 6)
  })
})
