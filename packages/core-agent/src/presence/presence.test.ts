import type { PresenceInput } from './arbiter'

import { describe, expect, it } from 'vitest'

import {
  decideAct,
  defaultPresenceConfig,
} from './arbiter'
import { defaultTimingConfig, planDelay } from './timing'

function calm(override: Partial<PresenceInput> = {}): PresenceInput {
  return {
    now: 100_000,
    lastUserAt: 0,
    userSpeaking: false,
    userSpeechMs: 0,
    speaking: false,
    answered: true,
    gates: { allowProvoke: true, allowThink: true },
    drives: { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 },
    mayProvoke: true,
    ...override,
  }
}

describe('decideAct', () => {
  it('does nothing when the companion is already speaking', () => {
    expect(decideAct(calm({ speaking: true })).act).toBe('silence')
  })

  it('stays quiet while the user speaks briefly', () => {
    const decision = decideAct(calm({ userSpeaking: true, userSpeechMs: 1_000 }))
    expect(decision).toEqual({ act: 'silence', reason: 'listening' })
  })

  it('makes a short sound when the user keeps talking', () => {
    const decision = decideAct(calm({ userSpeaking: true, userSpeechMs: 6_000 }))
    expect(decision.act).toBe('backchannel')
  })

  it('keeps the short sound off when thinking is not allowed', () => {
    const decision = decideAct(calm({
      userSpeaking: true,
      userSpeechMs: 6_000,
      gates: { allowProvoke: true, allowThink: false },
    }))
    expect(decision.act).toBe('silence')
  })

  it('answers a direct question', () => {
    const decision = decideAct(calm({ answered: false, lastUserAt: 99_000, now: 100_000 }))
    expect(decision).toEqual({ act: 'reply', reason: 'user addressed the companion' })
  })

  it('does not answer a question that already went stale', () => {
    const decision = decideAct(calm({ answered: false, lastUserAt: 0, now: 100_000 }))
    expect(decision.act).not.toBe('reply')
  })

  it('answers even when the gates block spontaneous speech', () => {
    const decision = decideAct(calm({
      answered: false,
      lastUserAt: 99_000,
      now: 100_000,
      gates: { allowProvoke: false, allowThink: true },
    }))
    expect(decision.act).toBe('reply')
  })

  it('brings up a held-back thought when the gates open', () => {
    const decision = decideAct(calm({ pendingThought: '你那个报错好了吗' }))
    expect(decision).toEqual({ act: 'initiate', reason: 'held-back thought is still relevant' })
  })

  it('keeps the thought for later while the cooldown runs', () => {
    const decision = decideAct(calm({ pendingThought: '你那个报错好了吗', mayProvoke: false }))
    expect(decision).toEqual({ act: 'defer', reason: 'gates or cooldown blocked it' })
  })

  it('starts a topic when bored and allowed', () => {
    const decision = decideAct(calm({ drives: { fatigue: 0, boredom: 61, curiosity: 0, focus: 0 } }))
    expect(decision).toEqual({ act: 'initiate', reason: 'bored' })
  })

  it('stays silent when bored but blocked instead of repeating itself', () => {
    const decision = decideAct(calm({
      drives: { fatigue: 0, boredom: 61, curiosity: 0, focus: 0 },
      mayProvoke: false,
    }))
    expect(decision.act).toBe('silence')
  })

  it('prefers a held-back thought over generic boredom', () => {
    const decision = decideAct(calm({
      pendingThought: '想问一句',
      drives: { fatigue: 0, boredom: 90, curiosity: 0, focus: 0 },
    }))
    expect(decision.reason).toBe('held-back thought is still relevant')
  })

  it('uses the configured thresholds', () => {
    const strict = { ...defaultPresenceConfig, initiateBoredom: 95 }
    const decision = decideAct(calm({ drives: { fatigue: 0, boredom: 61, curiosity: 0, focus: 0 } }), strict)
    expect(decision.act).toBe('silence')
  })
})

describe('planDelay', () => {
  it('never answers instantly', () => {
    expect(planDelay('reply', 0)).toBe(defaultTimingConfig.replyBaseMs)
    expect(planDelay('reply', 0)).toBeGreaterThan(200)
  })

  it('spreads replies across a range', () => {
    const slow = planDelay('reply', 1)
    expect(slow).toBe(defaultTimingConfig.replyBaseMs + defaultTimingConfig.replyJitterMs)
    expect(slow).toBeGreaterThan(planDelay('reply', 0))
  })

  it('clamps a jitter outside zero to one', () => {
    expect(planDelay('reply', -5)).toBe(planDelay('reply', 0))
    expect(planDelay('reply', 9)).toBe(planDelay('reply', 1))
  })

  it('keeps a short sound shorter than a reply', () => {
    expect(planDelay('backchannel', 1)).toBeLessThan(planDelay('reply', 0))
  })

  it('waits nothing for acts that make no sound', () => {
    expect(planDelay('silence', 0.5)).toBe(0)
    expect(planDelay('defer', 0.5)).toBe(0)
  })

  it('is deterministic for the same jitter', () => {
    expect(planDelay('reply', 0.42)).toBe(planDelay('reply', 0.42))
  })
})
