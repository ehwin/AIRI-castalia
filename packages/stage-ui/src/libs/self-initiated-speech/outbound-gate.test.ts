import type { OutboundPolicy, OutboundRequest, OutboundState } from './outbound-gate'

import { describe, expect, it, vi } from 'vitest'

import {
  createOutboundState,
  DAY_MS,
  decideOutbound,
  gapFactorOf,
  isQuietHour,
  nextGapFactor,
  OUTBOUND_POLICY_DEFAULTS,
  recordOutbound,
  recordOwnerMessage,
  setPaused,
  unansweredMultiplier,
} from './outbound-gate'

const HOUR = 3_600_000
/** Noon on a fixed day, so every case reads the same clock. */
const NOON = new Date(2026, 9, 28, 12, 0, 0).getTime()
const request = (over: Partial<OutboundRequest> = {}): OutboundRequest => ({ now: NOON, topic: 'hello', hour: 12, ...over })
const policy = (over: Partial<OutboundPolicy> = {}): OutboundPolicy => ({ ...OUTBOUND_POLICY_DEFAULTS, ...over })
const state = (over: Partial<OutboundState> = {}): OutboundState => ({ ...createOutboundState(NOON), ...over })

describe('outbound gate', () => {
  it('allows the first message of a fresh state', () => {
    expect(decideOutbound(request(), state())).toMatchObject({ allow: true, reason: 'allowed', intervalMultiplier: 1 })
  })

  it('refuses inside quiet hours and reports when the window ends', () => {
    const at2 = new Date(2026, 9, 28, 2, 0, 0).getTime()
    const decision = decideOutbound(request({ now: at2, hour: 2 }), state(), policy())
    expect(decision).toMatchObject({ allow: false, reason: 'quiet-hours' })
    expect(decision.retryAtMs).toBe(new Date(2026, 9, 28, 7, 0, 0).getTime())
  })

  it('refuses inside a quiet window that crosses midnight, and only there', () => {
    const overnight = policy({ quietStartHour: 23, quietEndHour: 7 })
    expect(isQuietHour(23, overnight)).toBe(true)
    expect(isQuietHour(2, overnight)).toBe(true)
    expect(isQuietHour(6, overnight)).toBe(true)
    expect(isQuietHour(7, overnight)).toBe(false)
    expect(isQuietHour(12, overnight)).toBe(false)
    expect(isQuietHour(22, overnight)).toBe(false)
  })

  it('refuses inside a quiet window that sits within one day', () => {
    const siesta = policy({ quietStartHour: 13, quietEndHour: 15 })
    expect(isQuietHour(14, siesta)).toBe(true)
    expect(isQuietHour(12, siesta)).toBe(false)
    expect(isQuietHour(15, siesta)).toBe(false)
  })

  it('treats an empty quiet window as no quiet hours', () => {
    expect(isQuietHour(3, policy({ quietStartHour: 7, quietEndHour: 7 }))).toBe(false)
  })

  it('refuses a second message inside the minimum gap', () => {
    // The owner answered, so no unanswered stretch applies to the gap.
    const sent = state({ lastSentAt: NOON - HOUR })
    const decision = decideOutbound(request({ now: NOON, topic: 'other' }), sent, policy({ minGapMs: 2 * HOUR }))
    expect(decision).toMatchObject({ allow: false, reason: 'min-gap', intervalMultiplier: 1 })
    expect(decision.retryAtMs).toBe(NOON + HOUR)
  })

  it('allows the message once the minimum gap passed', () => {
    const sent = state({ lastSentAt: NOON - 3 * HOUR })
    expect(decideOutbound(request({ now: NOON, topic: 'other' }), sent, policy({ minGapMs: 2 * HOUR })).allow).toBe(true)
  })

  it('refuses a repeated topic inside the dedupe window, and allows a new topic', () => {
    const sent = recordOutbound(state(), request({ now: NOON - 2 * HOUR, topic: 'weather' }))
    const repeated = decideOutbound(request({ now: NOON, topic: 'weather' }), sent, policy({ minGapMs: HOUR }))
    expect(repeated).toMatchObject({ allow: false, reason: 'duplicate' })
    expect(repeated.retryAtMs).toBe(NOON - 2 * HOUR + OUTBOUND_POLICY_DEFAULTS.dedupeWindowMs)
    expect(decideOutbound(request({ now: NOON, topic: 'dream' }), sent, policy({ minGapMs: HOUR })).allow).toBe(true)
  })

  it('allows a repeated topic after the dedupe window', () => {
    const sent = recordOutbound(state(), request({ now: NOON - 5 * HOUR, topic: 'weather' }))
    const later = NOON + 9 * HOUR
    expect(decideOutbound(request({ now: later, topic: 'weather', hour: 21 }), sent, policy({ minGapMs: HOUR })).allow).toBe(true)
  })

  it('refuses past the daily cap and reports the next day as the retry', () => {
    let current = state()
    for (let index = 0; index < 3; index += 1) {
      current = recordOutbound(current, request({ now: NOON + index * HOUR, topic: `topic-${index}` }))
    }
    const decision = decideOutbound(
      request({ now: NOON + 4 * HOUR, topic: 'later' }),
      current,
      policy({ dailyCap: 3, minGapMs: 0, pauseAfterUnanswered: 99 }),
    )
    expect(decision).toMatchObject({ allow: false, reason: 'daily-cap' })
    expect(decision.retryAtMs).toBe(NOON + DAY_MS)
  })

  it('rolls the daily count on the next day instead of the next calendar day', () => {
    let current = state()
    current = recordOutbound(current, request({ now: NOON, topic: 'a' }))
    current = recordOutbound(current, request({ now: NOON + HOUR, topic: 'b' }))
    expect(current.sentToday).toBe(2)
    const nextDay = recordOutbound(current, request({ now: NOON + DAY_MS + HOUR, topic: 'c' }))
    expect(nextDay.sentToday).toBe(1)
    expect(nextDay.dayStartedAt).toBe(NOON + DAY_MS + HOUR)
  })

  it('slows the pace as messages stay unanswered, and stops at the cap', () => {
    let current = state()
    expect(unansweredMultiplier(current, policy())).toBe(1)
    current = recordOutbound(current, request({ now: NOON, topic: 'a' }))
    expect(unansweredMultiplier(current, policy())).toBeCloseTo(1.35, 5)
    current = recordOutbound(current, request({ now: NOON, topic: 'b' }))
    expect(unansweredMultiplier(current, policy())).toBeCloseTo(1.8225, 4)
    current = recordOutbound(current, request({ now: NOON, topic: 'c' }))
    expect(unansweredMultiplier(current, policy())).toBe(2.2)
    current = recordOutbound(current, request({ now: NOON, topic: 'd' }))
    expect(unansweredMultiplier(current, policy())).toBe(2.2)
  })

  it('stretches the minimum gap by the unanswered factor', () => {
    let current = state()
    current = recordOutbound(current, request({ now: NOON, topic: 'a' }))
    const decision = decideOutbound(request({ now: NOON + HOUR, topic: 'b' }), current, policy({ minGapMs: HOUR }))
    expect(decision).toMatchObject({ allow: false, reason: 'min-gap', intervalMultiplier: 1.35 })
    expect(decision.retryAtMs).toBe(NOON + HOUR * 1.35)
  })

  it('waits for the owner after the unanswered run reaches the pause count', () => {
    let current = state()
    for (let index = 0; index < 3; index += 1) {
      current = recordOutbound(current, request({ now: NOON + index * HOUR, topic: `topic-${index}` }))
    }
    const decision = decideOutbound(request({ now: NOON + 8 * HOUR, topic: 'again', hour: 20 }), current, policy({ minGapMs: 0 }))
    expect(decision).toMatchObject({ allow: false, reason: 'unanswered-pause' })
    expect(decision.retryAtMs).toBeUndefined()
  })

  it('lifts the unanswered pause when the owner answers', () => {
    let current = state()
    for (let index = 0; index < 3; index += 1) {
      current = recordOutbound(current, request({ now: NOON + index * HOUR, topic: `topic-${index}` }))
    }
    const answered = recordOwnerMessage(current)
    expect(answered.unanswered).toBe(0)
    expect(decideOutbound(request({ now: NOON + 8 * HOUR, topic: 'again', hour: 20 }), answered, policy({ minGapMs: 0 })).allow).toBe(true)
  })

  it('keeps a hand-set pause across an owner message', () => {
    const paused = setPaused(state(), true)
    expect(decideOutbound(request(), paused)).toMatchObject({ allow: false, reason: 'paused', intervalMultiplier: 1 })
    expect(recordOwnerMessage(paused).paused).toBe(true)
    expect(decideOutbound(request(), setPaused(paused, false)).allow).toBe(true)
  })

  it('refuses when the policy is nonsense, so a broken setting silences outbound', () => {
    for (const broken of [
      policy({ minGapMs: Number.NaN }),
      policy({ quietStartHour: 24 }),
      policy({ quietEndHour: -1 }),
      policy({ dailyCap: Number.NaN }),
      policy({ unansweredGrowth: 0.5 }),
      policy({ unansweredGrowthCap: 0 }),
      policy({ pauseAfterUnanswered: 0 }),
      policy({ dedupeWindowMs: Number.NEGATIVE_INFINITY }),
    ]) {
      expect(decideOutbound(request(), state(), broken)).toMatchObject({ allow: false, reason: 'paused' })
    }
  })

  it('refuses a nonsense clock', () => {
    expect(decideOutbound(request({ now: Number.NaN }), state()).allow).toBe(false)
    expect(decideOutbound(request({ hour: Number.NaN }), state()).allow).toBe(false)
    expect(decideOutbound(request({ hour: -1 }), state()).allow).toBe(false)
  })

  it('reports the unanswered pause before the daily cap', () => {
    let current = state()
    for (let index = 0; index < 3; index += 1) {
      current = recordOutbound(current, request({ now: NOON + index * HOUR, topic: `topic-${index}` }))
    }
    const decision = decideOutbound(
      request({ now: NOON + 5 * HOUR, topic: 'later', hour: 17 }),
      current,
      policy({ dailyCap: 3, minGapMs: 0 }),
    )
    expect(decision.reason).toBe('unanswered-pause')
  })

  it('never changes the state it reads', () => {
    const before = state({ sentToday: 2, lastSentAt: NOON - HOUR, recentTopics: { weather: NOON - HOUR }, unanswered: 1 })
    const snapshot = structuredClone(before)
    decideOutbound(request({ topic: 'weather' }), before, policy())
    recordOutbound(before, request())
    recordOwnerMessage(before)
    setPaused(before, true)
    expect(before).toEqual(snapshot)
  })

  it('drops topics that left the dedupe window from the recorded map', () => {
    let current = state()
    current = recordOutbound(current, request({ now: NOON, topic: 'a' }))
    current = recordOutbound(current, request({ now: NOON + DAY_MS, topic: 'b' }))
    // The old topic is out of the window, so the gate allows it again.
    const decision = decideOutbound(
      request({ now: NOON + DAY_MS + HOUR, topic: 'a', hour: 13 }),
      current,
      policy({ minGapMs: 0, dailyCap: 99 }),
    )
    expect(decision.allow).toBe(true)
  })

  it('reads the quiet window from the clock of the caller, not from a fixed timezone', () => {
    const spy = vi.spyOn(Date.prototype, 'getHours')
    decideOutbound(request({ hour: 12 }), state())
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('answers the same decision for the same inputs twice', () => {
    const sent = recordOutbound(state(), request({ now: NOON - HOUR, topic: 'weather' }))
    expect(decideOutbound(request(), sent, policy())).toEqual(decideOutbound(request(), sent, policy()))
  })

  it('keeps the plane gap when no draw was stored', () => {
    // 老状态没有 gapFactor：间隔必须还是整整一小时，不能让升级本身改节奏。
    // 主人在间隔里回了一句：下一个间隔按基础倍率算，这段测的是抖动本身。
    const sent = recordOwnerMessage(recordOutbound(state(), request({ now: NOON - HOUR, topic: 'weather' })))

    expect(sent.gapFactor).toBeUndefined()
    expect(decideOutbound(request({ now: NOON - HOUR + 59 * 60_000, topic: 'later' }), sent, policy()))
      .toMatchObject({ allow: false, reason: 'min-gap' })
    expect(decideOutbound(request({ now: NOON, topic: 'later' }), sent, policy()).allow).toBe(true)
  })

  it('honours the wait the last message chose', () => {
    const tight = recordOwnerMessage(recordOutbound(state(), request({ now: NOON - HOUR }), { random: () => 0 }))
    const loose = recordOwnerMessage(recordOutbound(state(), request({ now: NOON - HOUR }), { random: () => 1 }))
    const fortyTwoMinutes = request({ now: NOON - HOUR + 42 * 60_000, topic: 'later' })

    expect(tight.gapFactor).toBeCloseTo(0.65, 6)
    expect(loose.gapFactor).toBeCloseTo(1.35, 6)
    expect(decideOutbound(fortyTwoMinutes, tight, policy()).allow).toBe(true)
    expect(decideOutbound(fortyTwoMinutes, loose, policy())).toMatchObject({ allow: false, reason: 'min-gap' })
  })

  it('clamps a nonsense draw instead of swallowing the pacing', () => {
    expect(gapFactorOf(state({ gapFactor: 99 }), policy())).toBeCloseTo(1.35, 6)
    expect(gapFactorOf(state({ gapFactor: 0.01 }), policy())).toBeCloseTo(0.65, 6)
    // 99 被夹到 1.35：60 分钟太早、82 分钟才放行。被夹到 1.35 而不是 99 就是「不许吞掉节奏」。
    expect(decideOutbound(request({ now: NOON - HOUR + 60 * 60_000, topic: 'later' }), state({ lastSentAt: NOON - HOUR, gapFactor: 99, unanswered: 0 }), policy()))
      .toMatchObject({ allow: false, reason: 'min-gap' })
    expect(decideOutbound(request({ now: NOON - HOUR + 82 * 60_000, topic: 'later' }), state({ lastSentAt: NOON - HOUR, gapFactor: 99, unanswered: 0 }), policy()).allow).toBe(true)
  })

  it('draws the next factor inside the band and nowhere else', () => {
    const draws = Array.from({ length: 500 }, () => nextGapFactor())
    const zero = nextGapFactor(() => 0)
    const one = nextGapFactor(() => 1)

    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0.65)
    expect(Math.max(...draws)).toBeLessThanOrEqual(1.35)
    expect(zero).toBeCloseTo(0.65, 6)
    expect(one).toBeCloseTo(1.35, 6)
    // 0 是关掉抖动：升级前后同一个行为，测试也能钉住旧节奏。
    expect(nextGapFactor(() => 0.2, 0)).toBe(1)
  })
})
