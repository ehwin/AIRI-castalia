import { describe, expect, it } from 'vitest'

import { AgentState, formatAgentStatePrompt } from './agent-state'

describe('castalia agent state', () => {
  it('clamps mood and energy and decays state against the injected clock', () => {
    let now = 0
    const state = new AgentState('castalia', () => now)

    state.addMood(20, 'positive event')
    state.setDesire('  keep learning  ')
    expect(state.getSnapshot()).toMatchObject({ currentMood: 10, currentDesire: 'keep learning', energy: 100 })

    state.boostEnergy(-160)
    now += 7 * 3_600_000
    expect(state.getSnapshot().energy).toBe(0)
    expect(state.getCurrentMood()).toBeLessThan(10)
  })

  it('keeps only the newest ten mood events in snapshots', () => {
    const state = new AgentState('castalia')
    for (let index = 0; index < 12; index += 1)
      state.addMood(index, `event ${index}`)

    expect(state.getSnapshot().moodHistory.map(event => event.reason)).toEqual([
      'event 2',
      'event 3',
      'event 4',
      'event 5',
      'event 6',
      'event 7',
      'event 8',
      'event 9',
      'event 10',
      'event 11',
    ])
  })

  it('keeps subjective mood evidence separate from the user and the stable persona', () => {
    const state = new AgentState('castalia')
    state.addMood(4, 'I enjoyed solving the puzzle.')
    state.setDesire('Learn another song.')
    const prompt = formatAgentStatePrompt(state.getSnapshot())

    expect(prompt).toContain('describe you, not the user')
    expect(prompt).toContain('Current desire: Learn another song.')
    expect(prompt).toContain('I enjoyed solving the puzzle.')
    expect(prompt).toContain('temporary subjective context')
  })
})
