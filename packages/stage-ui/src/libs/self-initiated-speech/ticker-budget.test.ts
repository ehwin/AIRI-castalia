import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSpeechTicker, SPEAK_BUDGET_MS } from './ticker'

function deciding() {
  return { speak: true, urge: 1, reason: 'accepted' } as never
}

const policy = {
  cooldownMs: 1,
  energyFloor: 0,
  baseChance: 1,
  idleChatterFactor: 1,
  userGraceMs: 0,
  random: () => 0,
} as never

/**
 * A stuck `speak` used to own the loop: the promise never settled, `sending` stayed true, and the
 * character never spoke again until the app restarted. The guard must hand the loop back.
 */
describe('speech ticker budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases a speak that never settles and reports it', () => {
    vi.useFakeTimers()
    const speak = vi.fn(() => new Promise<void>(() => {}))
    const onStuck = vi.fn()
    const ticker = createSpeechTicker({
      decide: deciding,
      policy,
      now: () => Date.now(),
      readInput: () => ({
        now: Date.now(),
        lastSpokeAt: null,
        lastUserAt: null,
        energy: 100,
        desire: '',
        arousal: 0,
        relationshipDepth: 1,
      }),
      speak,
      onStuck,
    })

    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(1)

    // Inside the budget the loop stays locked: a slow send must not queue a second one.
    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(SPEAK_BUDGET_MS + 1)
    expect(onStuck).toHaveBeenCalledTimes(1)

    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('keeps the lock when the speak settles in time', async () => {
    const speak = vi.fn(async () => {})
    const onStuck = vi.fn()
    const ticker = createSpeechTicker({
      decide: deciding,
      policy,
      now: () => Date.now(),
      readInput: () => ({
        now: Date.now(),
        lastSpokeAt: null,
        lastUserAt: null,
        energy: 100,
        desire: '',
        arousal: 0,
        relationshipDepth: 1,
      }),
      speak,
      onStuck,
      speakBudgetMs: 10,
    })

    ticker.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(onStuck).not.toHaveBeenCalled()

    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(2)
  })
})
