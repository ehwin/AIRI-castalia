import { afterEach, describe, expect, it, vi } from 'vitest'

import { getAgentState } from './vendor/engine/agentState'

describe('agent state energy mirror', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the host value instead of decaying between pushes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
    const state = getAgentState('mirror-test', 'mirror-test')

    state.setEnergy(80)
    vi.setSystemTime(new Date('2026-11-02T06:00:00Z'))

    // The mind pushes 100 − fatigue; between pushes nothing happened, so the
    // engine must not invent six hours of rest or decay (80 → 59 before).
    expect(state.getCurrentEnergy()).toBe(80)
  })

  it('still decays the gauge when nobody owns it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
    const state = getAgentState('decay-test', 'mirror-test')

    state.boostEnergy(-20) // 100 → 80, legacy decay mode
    vi.setSystemTime(new Date('2026-11-02T06:00:00Z'))

    expect(state.getCurrentEnergy()).toBeLessThan(70)
  })
})
