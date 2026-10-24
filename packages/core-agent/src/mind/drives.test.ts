import { describe, expect, it } from 'vitest'

import type { Drives } from './drives'

import {
  advanceDrives,
  decide,
  defaultActionThresholds,
  defaultDriveConfig,
  defaultGateConfig,
  gatesFrom,
  isQuietHour,
  quietEnvironment,
  relieveAfterSpeech,
  restDrives,
} from './drives'
import { defaultProvocationPolicy, mayProvoke, planExpression } from './expression'

const idle = (): Drives => ({ fatigue: 0, boredom: 0, curiosity: 0, focus: 0 })
const after = (minutes: number) => minutes * 60_000

describe('advanceDrives', () => {
  it('grows boredom while the user is silent', () => {
    const next = advanceDrives(idle(), after(20), { ...quietEnvironment, idleMs: after(20) })
    expect(next.boredom).toBeCloseTo(30, 5)
  })

  it('relieves boredom when the user is active', () => {
    const start = { ...idle(), boredom: 60 }
    const next = advanceDrives(start, after(1), { ...quietEnvironment, idleMs: 5_000 })
    expect(next.boredom).toBeCloseTo(58.5, 5)
  })

  it('spikes curiosity on novelty and halves it after one half-life', () => {
    const spiked = advanceDrives(idle(), after(1), { ...quietEnvironment, novelty: true })
    expect(spiked.curiosity).toBeCloseTo(30, 5)

    const decayed = advanceDrives(spiked, defaultDriveConfig.curiosityHalfLifeMs, quietEnvironment)
    expect(decayed.curiosity).toBeCloseTo(15, 5)
  })

  it('clamps every gauge into 0 to 100', () => {
    const start = { fatigue: 99, boredom: 99, curiosity: 99, focus: 99 }
    const next = advanceDrives(start, after(600), quietEnvironment)
    for (const value of Object.values(next))
      expect(value).toBeLessThanOrEqual(100)
  })

  it('keeps working while the user is active and relaxes when they stop', () => {
    const start = { ...idle(), focus: 50 }
    const raised = advanceDrives(start, after(5), { ...quietEnvironment, idleMs: 1_000 })
    expect(raised.focus).toBeCloseTo(80, 5)

    const fallen = advanceDrives(raised, after(10), { ...quietEnvironment, idleMs: after(10) })
    expect(fallen.focus).toBeCloseTo(60, 5)
  })
})

describe('restDrives', () => {
  it('clears a full battery after eight hours away', () => {
    const next = restDrives({ ...idle(), fatigue: 100 }, 8 * 3_600_000)
    expect(next.fatigue).toBe(0)
  })

  it('never goes below zero', () => {
    const next = restDrives({ ...idle(), fatigue: 5 }, 100 * 3_600_000)
    expect(next.fatigue).toBe(0)
  })
})

describe('relieveAfterSpeech', () => {
  it('lowers boredom and curiosity after one invitation', () => {
    const next = relieveAfterSpeech({ fatigue: 10, boredom: 70, curiosity: 40, focus: 20 })
    expect(next).toEqual({ fatigue: 10, boredom: 25, curiosity: 30, focus: 20 })
  })

  it('never goes below zero', () => {
    const next = relieveAfterSpeech({ fatigue: 10, boredom: 5, curiosity: 2, focus: 0 })
    expect(next.boredom).toBe(0)
    expect(next.curiosity).toBe(0)
  })
})

describe('gatesFrom', () => {
  it('blocks speech in a fullscreen app but still allows thinking', () => {
    const gates = gatesFrom({ ...quietEnvironment, fullscreen: true })
    expect(gates).toEqual({ allowProvoke: false, allowThink: true })
  })

  it('blocks speech while the microphone is open', () => {
    expect(gatesFrom({ ...quietEnvironment, micActive: true }).allowProvoke).toBe(false)
  })

  it('blocks speech during quiet hours', () => {
    expect(gatesFrom({ ...quietEnvironment, hourOfDay: 3 }).allowProvoke).toBe(false)
  })

  it('allows speech in the afternoon', () => {
    expect(gatesFrom({ ...quietEnvironment, hourOfDay: 15 }).allowProvoke).toBe(true)
  })

  it('uses midnight to eight by default', () => {
    expect(isQuietHour(3, defaultGateConfig)).toBe(true)
    expect(isQuietHour(9, defaultGateConfig)).toBe(false)
  })

  it('treats a quiet window that crosses midnight correctly', () => {
    const lateNight = { ...defaultGateConfig, quietHoursStart: 22, quietHoursEnd: 7 }
    expect(isQuietHour(23, lateNight)).toBe(true)
    expect(isQuietHour(3, lateNight)).toBe(true)
    expect(isQuietHour(12, lateNight)).toBe(false)
    expect(isQuietHour(7, lateNight)).toBe(false)
  })
})

describe('decide', () => {
  it('provokes when boredom crosses the threshold and the gates allow it', () => {
    const gates = gatesFrom({ ...quietEnvironment, hourOfDay: 15 })
    expect(decide({ ...idle(), boredom: 61 }, gates)).toBe('provoke')
  })

  it('stays idle when fatigue passes the sleep threshold, even when bored', () => {
    const gates = gatesFrom({ ...quietEnvironment, hourOfDay: 15 })
    expect(decide({ ...idle(), boredom: 90, fatigue: 85 }, gates)).toBe('idle')
  })

  it('stays idle when the gates block speech and nothing else demands action', () => {
    const gates = gatesFrom({ ...quietEnvironment, fullscreen: true })
    expect(decide({ ...idle(), boredom: 61 }, gates)).toBe('idle')
  })

  it('thinks when curiosity crosses the think threshold', () => {
    const gates = gatesFrom({ ...quietEnvironment, hourOfDay: 15 })
    expect(decide({ ...idle(), curiosity: 60 }, gates)).toBe('think')
  })

  it('prefers speaking over thinking when both cross their thresholds', () => {
    const gates = gatesFrom({ ...quietEnvironment, hourOfDay: 15 })
    expect(decide({ ...idle(), boredom: 70, curiosity: 70 }, gates)).toBe('provoke')
  })

  it('uses the configured thresholds', () => {
    const gates = gatesFrom({ ...quietEnvironment, hourOfDay: 15 })
    const strict = { ...defaultActionThresholds, provoke: 95 }
    expect(decide({ ...idle(), boredom: 61 }, gates, strict)).toBe('idle')
  })
})

describe('mayProvoke', () => {
  it('refuses while the gap has not passed', () => {
    expect(mayProvoke(1_000, 0, 0)).toBe(false)
  })

  it('refuses when the hourly budget is spent', () => {
    const later = defaultProvocationPolicy.minGapMs + 1
    expect(mayProvoke(later, 0, defaultProvocationPolicy.maxPerHour)).toBe(false)
  })

  it('allows a measured invitation', () => {
    const later = defaultProvocationPolicy.minGapMs + 1
    expect(mayProvoke(later, 0, 0)).toBe(true)
  })
})

describe('planExpression', () => {
  const allowed = gatesFrom({ ...quietEnvironment, hourOfDay: 15 })
  const now = 10 * defaultProvocationPolicy.minGapMs

  it('speaks when the gates and the policy allow it', () => {
    const plan = planExpression({ action: 'provoke', gates: allowed, now, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: 0 })
    expect(plan).toEqual({ level: 'L2', heldBack: false })
  })

  it('drops to a bubble when the gates block speech', () => {
    const blocked = gatesFrom({ ...quietEnvironment, fullscreen: true })
    const plan = planExpression({ action: 'provoke', gates: blocked, now, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: 0 })
    expect(plan).toEqual({ level: 'L1', heldBack: true })
  })

  it('drops to a bubble when the cooldown is still running', () => {
    const plan = planExpression({ action: 'provoke', gates: allowed, now: 1_000, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: -1_000_000 })
    expect(plan).toEqual({ level: 'L1', heldBack: true })
  })

  it('holds the bubble back until its own gap passes', () => {
    const blocked = gatesFrom({ ...quietEnvironment, fullscreen: true })
    const first = planExpression({ action: 'provoke', gates: blocked, now, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: 0 })
    expect(first.level).toBe('L1')

    const soon = planExpression({ action: 'provoke', gates: blocked, now: now + 1_000, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: now })
    expect(soon).toEqual({ level: 'L0', heldBack: true })
  })

  it('keeps idle and think at a gesture', () => {
    expect(planExpression({ action: 'idle', gates: allowed, now, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: 0 }).level).toBe('L0')
    expect(planExpression({ action: 'think', gates: allowed, now, lastSpokeAt: 0, spokenLastHour: 0, lastBubbleAt: 0 }).level).toBe('L0')
  })
})
