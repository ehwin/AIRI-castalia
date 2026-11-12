import { describe, expect, it } from 'vitest'

import { decide, defaultActionThresholds } from './drives'
import {
  createRandom,
  dailyJitter,
  defaultNoiseConfig,
  gaussian,
  jitteredThresholds,
  noiseDayKey,
  seedFrom,
  stepWobble,
  stillWobble,
  withWobble,
} from './noise'

const MINUTE = 60_000
const TICK = 45_000

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sd(values: number[]): number {
  const m = mean(values)
  return Math.sqrt(mean(values.map(value => (value - m) ** 2)))
}

describe('noise', () => {
  it('replays the same sequence from the same seed', () => {
    const a = createRandom(20261112)
    const b = createRandom(20261112)
    const left = Array.from({ length: 20 }, () => a())
    const right = Array.from({ length: 20 }, () => b())

    expect(left).toEqual(right)
    expect(new Set(left).size).toBe(20)
  })

  it('gives two seeds different streams', () => {
    const a = Array.from({ length: 10 }, createRandom(1))
    const b = Array.from({ length: 10 }, createRandom(2))

    expect(a).not.toEqual(b)
  })

  it('hashes text to a stable uint32 seed', () => {
    expect(seedFrom('airi')).toBe(seedFrom('airi'))
    expect(seedFrom('airi')).not.toBe(seedFrom('airi '))
    expect(seedFrom('airi')).toBeGreaterThanOrEqual(0)
    expect(seedFrom('airi')).toBeLessThan(2 ** 32)
  })

  it('draws standard normals', () => {
    const random = createRandom(7)
    const draws = Array.from({ length: 20_000 }, () => gaussian(random))

    expect(Math.abs(mean(draws))).toBeLessThan(0.05)
    expect(sd(draws)).toBeGreaterThan(0.95)
    expect(sd(draws)).toBeLessThan(1.05)
  })

  it('keeps the wobble inside a mood-sized band', () => {
    const random = createRandom(11)
    let wobble = stillWobble(0)
    let now = 0
    const seen: number[] = []

    for (let i = 0; i < 5000; i++) {
      now += TICK
      wobble = stepWobble(wobble, now, defaultNoiseConfig, random)
      seen.push(wobble.boredom)
    }

    // Stationary spread equals sigma: the sqrt(1 - a^2) factor is what makes the
    // step length irrelevant.
    expect(sd(seen)).toBeGreaterThan(defaultNoiseConfig.sigma * 0.85)
    expect(sd(seen)).toBeLessThan(defaultNoiseConfig.sigma * 1.15)
    // Three sigma is the band behaviour may move by; anything past it is a bug.
    expect(Math.max(...seen.map(Math.abs))).toBeLessThan(defaultNoiseConfig.sigma * 4.5)
  })

  it('drops the old mood after a long absence instead of carrying it', () => {
    // The point is memorylessness, not smallness: a suspended laptop must draw a
    // fresh mood, so two different yesterday-values land in the same place.
    const at = 10 * defaultNoiseConfig.tauMs
    const fromHigh = stepWobble({ boredom: 9, curiosity: -9, at: 0 }, at, defaultNoiseConfig, createRandom(5))
    const fromLow = stepWobble({ boredom: -9, curiosity: 9, at: 0 }, at, defaultNoiseConfig, createRandom(5))

    // 8.2e-4 apart at 10 tau: the old mood keeps 4.5e-5 of itself, which is the
    // whole claim — a fresh draw, not yesterday at half strength.
    expect(fromHigh.boredom).toBeCloseTo(fromLow.boredom, 2)
    expect(fromHigh.curiosity).toBeCloseTo(fromLow.curiosity, 2)
  })

  it('does not move at all when no time passed', () => {
    const wobble = { boredom: 4, curiosity: -3, at: 1000 }

    expect(stepWobble(wobble, 1000, defaultNoiseConfig, () => 0)).toBe(wobble)
  })

  it('draws one offset per day, stable across reads', () => {
    const first = dailyJitter('airi', '2026-11-12')
    const again = dailyJitter('airi', '2026-11-12')
    const others = Array.from({ length: 30 }, (_, index) => dailyJitter('airi', `2026-11-${index + 1}`))

    expect(first).toBe(again)
    expect(new Set(others).size).toBeGreaterThan(10)
    for (const offset of others) {
      expect(Math.abs(offset)).toBeLessThanOrEqual(defaultNoiseConfig.jitter)
    }
  })

  it('gives two characters their own days', () => {
    const airi = Array.from({ length: 20 }, (_, index) => dailyJitter('airi', `2026-12-${index + 1}`))
    const other = Array.from({ length: 20 }, (_, index) => dailyJitter('yuno', `2026-12-${index + 1}`))

    expect(airi).not.toEqual(other)
  })

  it('changes the day while she is asleep, not at midnight', () => {
    const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

    // 23:59 与次日 00:30 属于同一个「日」：偏移不能在零点跳，零点一跳就是阈值跳。
    expect(noiseDayKey(at(12, 23, 59))).toBe(noiseDayKey(at(13, 0, 30)))
    // 04:00 才是换日点：凌晨 3:59 还属于前一天。
    expect(noiseDayKey(at(13, 3, 59))).not.toBe(noiseDayKey(at(13, 4, 0)))
    expect(dailyJitter('airi', noiseDayKey(at(12, 23, 59)))).toBe(dailyJitter('airi', noiseDayKey(at(13, 0, 30))))
  })

  it('jitters the thresholds that make her act and nothing else', () => {
    const shifted = jitteredThresholds(defaultActionThresholds, 5)

    expect(shifted.provoke).toBe(65)
    expect(shifted.think).toBe(60)
    expect(shifted.napBoredom).toBe(80)
    expect(shifted.napFatigue).toBe(40)
    // The safety valve and the mid-conversation guard are not preferences.
    expect(shifted.sleep).toBe(defaultActionThresholds.sleep)
    expect(shifted.wake).toBe(defaultActionThresholds.wake)
    expect(shifted.sleepIdleMs).toBe(defaultActionThresholds.sleepIdleMs)
    expect(jitteredThresholds(defaultActionThresholds, -5).provoke).toBe(55)
  })

  it('clamps the wobbled drives to the gauge', () => {
    const drives = { fatigue: 0, boredom: 98, curiosity: 1, focus: 0 }

    expect(withWobble(drives, { boredom: 9, curiosity: -9, at: 0 })).toEqual({
      fatigue: 0,
      boredom: 100,
      curiosity: 0,
      focus: 0,
    })
  })

  describe('the think-or-provoke draw', () => {
    const bored = (curiosity: number) => ({ fatigue: 0, boredom: 90, curiosity, focus: 0 })

    it('stays certain without a random source', () => {
      expect(decide(bored(55))).toBe('think')
      expect(decide(bored(54))).toBe('provoke')
    })

    it('is a coin on the line', () => {
      const random = createRandom(3)
      const drawn = Array.from({ length: 2000 }, () =>
        decide(bored(55), defaultActionThresholds, { random }))

      expect(drawn.filter(action => action === 'think').length / drawn.length).toBeCloseTo(0.5, 1)
    })

    it('stays a decision far from the line', () => {
      const random = createRandom(3)
      const high = Array.from({ length: 2000 }, () =>
        decide(bored(90), defaultActionThresholds, { random }))
      const low = Array.from({ length: 2000 }, () =>
        decide(bored(20), defaultActionThresholds, { random }))

      expect(high.filter(action => action === 'think').length / high.length).toBeGreaterThan(0.99)
      expect(low.filter(action => action === 'provoke').length / low.length).toBeGreaterThan(0.99)
    })

    it('never flips a sleep or a nap on a draw', () => {
      const random = () => 0
      const tired = { fatigue: 90, boredom: 10, curiosity: 0, focus: 0 }

      expect(decide(tired, defaultActionThresholds, { idleMs: 11 * MINUTE, random })).toBe('sleep')
    })
  })
})
