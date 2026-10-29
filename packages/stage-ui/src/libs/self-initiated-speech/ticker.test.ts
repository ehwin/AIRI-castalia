import type { AutonomyInput, SpeakDecision } from './speak-decision'

import { describe, expect, it, vi } from 'vitest'

import { AUTONOMY_POLICY_DEFAULTS } from './speak-decision'
import { createSpeechTicker } from './ticker'

function decideAlways(speak: boolean) {
  return (): SpeakDecision => ({ speak, reason: speak ? 'speak' : 'cooldown', urge: speak ? 1 : 0 })
}

function createInput(now: number, lastSpokeAt: number | null): AutonomyInput {
  return {
    now,
    lastSpokeAt,
    lastUserAt: null,
    energy: 100,
    desire: 'finish the song',
    arousal: 0,
    relationshipDepth: 1,
  }
}

describe('speech ticker', () => {
  it('does not spend the cooldown when the gate refuses the message', () => {
    const speak = vi.fn()
    const onGated = vi.fn()
    const gate = vi.fn(() => ({ allow: false, reason: 'quiet-hours' }))
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 9000,
      readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
      speak,
      gate,
      onGated,
    })

    ticker.tick()

    expect(speak).not.toHaveBeenCalled()
    expect(onGated).toHaveBeenCalledWith({ allow: false, reason: 'quiet-hours' })
    // The refusal is not an utterance, so the next tick still sees no last time.
    expect(ticker.lastSpokeAt()).toBeNull()
  })

  it('speaks on the next tick once the gate opens', () => {
    const speak = vi.fn()
    let open = false
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 9000,
      readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
      speak,
      gate: () => (open ? { allow: true, reason: 'allowed' } : { allow: false, reason: 'quiet-hours' }),
    })

    ticker.tick()
    expect(speak).not.toHaveBeenCalled()

    open = true
    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(1)
    expect(ticker.lastSpokeAt()).toBe(9000)
  })

  it('refuses when the gate throws, and keeps the loop alive', () => {
    const speak = vi.fn()
    const onGated = vi.fn()
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 9000,
      readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
      speak,
      gate: () => {
        throw new Error('gate exploded')
      },
      onGated,
    })

    expect(() => ticker.tick()).not.toThrow()
    expect(speak).not.toHaveBeenCalled()
    expect(onGated).toHaveBeenCalledWith({ allow: false, reason: 'gate-error' })
  })

  it('does nothing while no persona is ready', () => {
    const speak = vi.fn()
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 1000,
      readInput: () => undefined,
      speak,
    })

    expect(ticker.tick()).toBeUndefined()
    expect(speak).not.toHaveBeenCalled()
  })

  it('hands the previous utterance time to the next tick', () => {
    const readInput = vi.fn(({ now, lastSpokeAt }: { now: number, lastSpokeAt: number | null }) => createInput(now, lastSpokeAt))
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 5000,
      readInput,
      speak: vi.fn(),
    })

    ticker.tick()
    expect(ticker.lastSpokeAt()).toBe(5000)
    expect(readInput.mock.calls[0]![0]).toMatchObject({ lastSpokeAt: null })

    ticker.tick()
    expect(readInput.mock.calls[1]![0]).toMatchObject({ lastSpokeAt: 5000 })
  })

  it('never overlaps two sends', async () => {
    let release: () => void = () => {}
    const speak = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 1000,
      readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
      speak,
    })

    ticker.tick()
    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(1)

    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('keeps ticking after a failed send', async () => {
    const speak = vi.fn()
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValue(undefined)
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 1000,
      readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
      speak,
    })

    ticker.tick()
    await Promise.resolve()
    await Promise.resolve()
    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('keeps ticking after a send that throws before it returns a promise', () => {
    const speak = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('send threw')
      })
      .mockImplementation(() => undefined)
    const ticker = createSpeechTicker({
      decide: decideAlways(true),
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
      now: () => 1000,
      readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
      speak,
    })

    expect(() => ticker.tick()).not.toThrow()
    ticker.tick()
    expect(speak).toHaveBeenCalledTimes(2)
  })

  it('runs on its own timer and stops when asked', async () => {
    vi.useFakeTimers()
    try {
      const speak = vi.fn()
      const ticker = createSpeechTicker({
        decide: decideAlways(false),
        policy: { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0 },
        now: () => 1000,
        readInput: ({ now, lastSpokeAt }) => createInput(now, lastSpokeAt),
        speak,
        tickMs: 1000,
      })

      ticker.start()
      expect(ticker.isRunning()).toBe(true)
      await vi.advanceTimersByTimeAsync(3000)

      ticker.stop()
      expect(ticker.isRunning()).toBe(false)
      await vi.advanceTimersByTimeAsync(3000)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
