import { describe, expect, it } from 'vitest'

import { AgentState, formatAgentStatePrompt, formatSelfStatePrompt } from './agent-state'

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

    expect(prompt).toContain('describes you, not the user')
    expect(prompt).toContain('What you want right now: Learn another song.')
    expect(prompt).toContain('I enjoyed solving the puzzle.')
    expect(prompt).toContain('temporary subjective context')
  })

  it('injects narration, never scale numbers or key=value the model can parrot', () => {
    const state = new AgentState('castalia')
    state.addMood(-6, 'The argument went badly.')
    state.setDesire('Give it a day before speaking again.')
    const snapshot = { ...state.getSnapshot(), vad: { valence: -0.6, arousal: 0.5, dominance: -0.4 } }
    const prompt = formatAgentStatePrompt(snapshot)

    // 数字、字段名、方括号是 AIRI #1539 里被弱模型复读的三种形状
    expect(prompt).not.toMatch(/\d/)
    expect(prompt).not.toMatch(/\bvad\b|valence|arousal|dominance/i)
    expect(prompt).not.toMatch(/[[\]]/)
    expect(prompt).toContain('cooler than usual')
    expect(prompt).toContain('keyed up')
    expect(prompt).toContain('carried along by things')
    // 倾向而非命令：必须把表达权交回角色
    expect(prompt).toContain('yours to decide')
  })

  it('merges feeling, drives and mind energy into one block', () => {
    const state = new AgentState('castalia')
    state.setDesire('Finish the song.')
    const snapshot = {
      ...state.getSnapshot(),
      vad: { valence: 0.4, arousal: 0.1, dominance: 0.2 },
      mood: { valence: 0.1, arousal: -0.4, dominance: 0.1 },
    }

    const prompt = formatSelfStatePrompt(snapshot, { drivesLine: 'very bored, curious', energy: 12 })
    expect(prompt).toContain('warmer than usual')
    expect(prompt).toContain('slow and quiet')
    expect(prompt).toContain('Meanwhile you are very bored, curious.')
    expect(prompt).toContain('You are running on empty.')
    expect(prompt).toContain('What you want right now: Finish the song.')
    expect(prompt).not.toMatch(/\d/)
  })

  it('says nothing at all when there is no state worth reporting', () => {
    const state = new AgentState('castalia')
    expect(formatAgentStatePrompt(state.getSnapshot())).toBe('')
  })
  it('does not claim a feeling when the engine has no reading', () => {
    const snapshot = {
      characterId: 'castalia',
      currentMood: 0,
      currentDesire: null,
      energy: 90,
      tsundereLevel: 0,
      lastUpdated: new Date(0).toISOString(),
      moodHistory: [],
    }
    const prompt = formatSelfStatePrompt(snapshot, { drivesLine: 'a little bored' })

    expect(prompt).not.toContain('Right now you feel')
    expect(prompt).toContain('Meanwhile you are a little bored.')
  })

  it('does not let one repeated event fill both slots', () => {
    // She records "spoke" every time she reaches out. The prompt must say what happened, not how
    // often it happened, or a chatty afternoon reads as two identical lines.
    const prompt = formatSelfStatePrompt({
      characterId: 'castalia',
      currentMood: 4,
      currentDesire: null,
      energy: 90,
      tsundereLevel: 0,
      lastUpdated: new Date(0).toISOString(),
      moodHistory: [
        { value: 1, reason: '我主动跟主人开口了', timestamp: 1 },
        { value: 2, reason: '主人点开了我分享的视频', timestamp: 2 },
        { value: 1, reason: '我主动跟主人开口了', timestamp: 3 },
      ],
    })

    expect(prompt.match(/我主动跟主人开口了/g)).toHaveLength(1)
    expect(prompt).toContain('主人点开了我分享的视频')
  })

  it('does not print the mirror marker as something that happened', () => {
    const prompt = formatSelfStatePrompt({
      characterId: 'castalia',
      currentMood: 4,
      currentDesire: null,
      energy: 90,
      tsundereLevel: 0,
      lastUpdated: new Date(0).toISOString(),
      moodHistory: [{ value: 4, reason: 'psyche', timestamp: 1 }],
      vad: { valence: 0.4, arousal: 0.3, dominance: 0.2 },
    })

    expect(prompt).not.toContain('- psyche')
    expect(prompt).toContain('Right now you feel')
  })
})

describe('self-state slow layer sentence', () => {
  const base = {
    characterId: 'c',
    currentMood: 0,
    currentDesire: null,
    energy: 90,
    tsundereLevel: 0,
    lastUpdated: new Date().toISOString(),
    moodHistory: [],
    vad: { valence: 0.4, arousal: 0.1, dominance: 0.2 },
    band: 'neutral',
  } as any

  it('is omitted when the slow layer is off and mood equals the fast layer', () => {
    const text = formatSelfStatePrompt({ ...base, mood: { ...base.vad } })
    expect(text).not.toContain('Underneath that')
  })

  it('is printed when the layers actually differ', () => {
    const text = formatSelfStatePrompt({ ...base, mood: { valence: -0.3, arousal: 0.1, dominance: 0.2 } })
    expect(text).toContain('Underneath that')
  })
})
