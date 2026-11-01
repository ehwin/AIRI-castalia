import { describe, expect, it } from 'vitest'

import { decideVideoWatch, isQuietHour, VIDEO_WATCH_POLICY_DEFAULTS } from './policy'

const now = new Date('2026-11-01T15:00:00+08:00').getTime()

function input(overrides: Partial<Parameters<typeof decideVideoWatch>[0]> = {}) {
  return {
    now,
    idleMs: 60 * 60_000,
    queueAgeMs: 60 * 60_000,
    pending: 2,
    watchedToday: 0,
    lastWatchedAt: null as number | null,
    curiosity: 0.5,
    random: 0,
    ...overrides,
  }
}

describe('video watch policy', () => {
  it('says nothing to do when the queue is empty', () => {
    expect(decideVideoWatch(input({ pending: 0 }))).toEqual({ watch: false, reason: 'empty', chance: 0 })
  })

  it('stops at the daily cap', () => {
    expect(decideVideoWatch(input({ watchedToday: VIDEO_WATCH_POLICY_DEFAULTS.dailyCap })).reason).toBe('daily-cap')
  })

  it('keeps a gap between two watches', () => {
    const decision = decideVideoWatch(input({ lastWatchedAt: now - 10 * 60_000 }))
    expect(decision.reason).toBe('too-soon')
  })

  it('never starts a clip mid-conversation', () => {
    expect(decideVideoWatch(input({ idleMs: 30_000 })).reason).toBe('busy')
  })

  it('does not start one in the quiet hours', () => {
    const night = new Date('2026-11-01T03:30:00+08:00').getTime()
    expect(decideVideoWatch(input({ now: night })).reason).toBe('quiet-hours')
  })

  it('drops an item that waited too long instead of watching it now', () => {
    expect(decideVideoWatch(input({ queueAgeMs: VIDEO_WATCH_POLICY_DEFAULTS.staleAfterMs + 1 })).reason).toBe('stale')
  })

  it('rolls the odds once every gate passed', () => {
    // At curiosity 0.5 and one hour of waiting: 0.3 * (0.5 + 0.5) * (1 + 1) = 0.6.
    const watch = decideVideoWatch(input({ random: 0.1 }))
    const skip = decideVideoWatch(input({ random: 0.9 }))
    expect(watch.watch).toBe(true)
    expect(watch.chance).toBeCloseTo(0.6, 2)
    expect(skip).toMatchObject({ watch: false, reason: 'chance' })
  })

  it('becomes likelier the longer a clip waits and the more curious she is', () => {
    const fresh = decideVideoWatch(input({ queueAgeMs: 0, random: 0.99 })).chance
    const waited = decideVideoWatch(input({ queueAgeMs: 3 * 3_600_000, random: 0.99 })).chance
    const curious = decideVideoWatch(input({ curiosity: 1, random: 0.99 })).chance
    expect(waited).toBeGreaterThan(fresh)
    expect(curious).toBeGreaterThan(fresh)
    // Never a certainty: a tick that always fires would empty the queue in three minutes.
    expect(decideVideoWatch(input({ curiosity: 1, queueAgeMs: 9 * 3_600_000, random: 0.99 })).chance).toBeLessThanOrEqual(0.95)
  })

  it('reads quiet hours that wrap midnight', () => {
    expect(isQuietHour(new Date('2026-11-01T23:30:00+08:00').getTime(), [22, 7])).toBe(true)
    expect(isQuietHour(new Date('2026-11-01T03:00:00+08:00').getTime(), [22, 7])).toBe(true)
    expect(isQuietHour(new Date('2026-11-01T12:00:00+08:00').getTime(), [22, 7])).toBe(false)
    expect(isQuietHour(new Date('2026-11-01T12:00:00+08:00').getTime(), [9, 9])).toBe(false)
  })
})
