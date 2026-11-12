import type { Drives } from '../mind/drives'

import { describe, expect, it, vi } from 'vitest'

import { advanceDrives, decide, gatesFrom, isQuietHour, quietEnvironment, relieveAfterSpeech, restDrives } from '../mind/drives'
import { planExpression } from '../mind/expression'
import { planReturn } from '../persona/absence'
import { composeThought } from '../persona/background-lane'
import { createStream, record, sharedRatio, surface } from '../persona/inner-stream'
import { createRefusalState, evaluateRefusal } from '../persona/refusal-policy'
import { inferRequestTraits } from '../persona/request-traits'
import { renderStateLine } from '../persona/state-line'
import { replay } from './session-log'
import { runTurn } from './turn-loop'

const TICK_MS = 45_000

/** One tick of the mind loop, exactly as `mind.ts` runs it. */
function tick(drives: Drives, now: number, busy: boolean) {
  const signals = {
    ...quietEnvironment,
    hourOfDay: new Date(now).getHours(),
    idleMs: busy ? 1_000 : 15 * 60_000,
    fullscreen: busy,
  }
  const next = advanceDrives(drives, TICK_MS, signals)
  const gates = gatesFrom(signals)
  const action = decide(next)
  return { drives: next, gates, action }
}

describe('a day in the life', () => {
  it('stays silent at first, then looks for company once bored', () => {
    let drives: Drives = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }
    let now = new Date('2026-10-25T10:00:00').getTime()
    let lastSpokeAt = -Infinity
    let lastBubbleAt = -Infinity
    const acts: string[] = []

    for (let i = 0; i < 80; i++) {
      now += TICK_MS
      const stepped = tick(drives, now, false)
      drives = stepped.drives
      const plan = planExpression({
        action: stepped.action,
        gates: stepped.gates,
        now,
        lastSpokeAt,
        lastBubbleAt,
        spokenLastHour: 0,
      })
      acts.push(plan.level)
      if (plan.level === 'L2') {
        lastSpokeAt = now
        drives = relieveAfterSpeech(drives)
      }
      if (plan.level === 'L1')
        lastBubbleAt = now
    }

    // 80 ticks of 45s is one hour. It must speak at least once, and not constantly.
    const spoken = acts.filter(level => level === 'L2').length
    expect(spoken).toBeGreaterThanOrEqual(1)
    expect(spoken).toBeLessThanOrEqual(3)
    expect(acts[0]).toBe('L0')
  })

  it('keeps quiet in a fullscreen meeting while wanting to talk', () => {
    let drives: Drives = { fatigue: 0, boredom: 61, curiosity: 0, focus: 0 }
    let now = new Date('2026-10-25T15:00:00').getTime()
    const levels: string[] = []

    for (let i = 0; i < 6; i++) {
      now += TICK_MS
      const stepped = tick(drives, now, true) // fullscreen
      drives = stepped.drives
      const plan = planExpression({
        action: stepped.action,
        gates: stepped.gates,
        now,
        lastSpokeAt: -Infinity,
        lastBubbleAt: -Infinity,
        spokenLastHour: 0,
      })
      levels.push(`${plan.level}${plan.heldBack ? '-held' : ''}`)
    }

    // Blocked by the gate, she does not go quiet: she shows a bubble instead.
    expect(levels.includes('L1-held')).toBe(true)
    expect(levels).not.toContain('L2')
  })

  it('ignores the user overnight and wakes up rested', () => {
    const evening: Drives = { fatigue: 70, boredom: 40, curiosity: 30, focus: 10 }
    expect(isQuietHour(3)).toBe(true)

    const report = planReturn({
      awayMs: 8 * 3_600_000,
      drives: evening,
      journal: [{ id: 'a', at: 1, text: 'archived two notes', visibility: 'private' }],
      hourOfDay: 8,
    })

    expect(report.slept).toBe(true)
    expect(report.drives.fatigue).toBe(0)
    expect(report.opening).toBe('archived two notes')
  })
})

describe('the background lane', () => {
  it('writes private thoughts only when bored, and the user sees one only after poking', () => {
    let stream = createStream()
    let written = 0

    for (let i = 0; i < 20; i++) {
      const thought = composeThought({
        now: i * 1_000,
        drives: { fatigue: 0, boredom: 40, curiosity: 0, focus: 0 },
        observations: ['the build failed', 'the tests went green'],
        roll: i / 100, // always under the 0.25 chance
      })
      if (thought) {
        written++
        stream = record(stream, thought)
      }
    }

    expect(written).toBeGreaterThan(0)
    expect(sharedRatio(stream)).toBe(0)

    // A thought from one second ago is still being had.
    expect(surface(stream, 19_000, 30_000)).toBeUndefined()
    expect(surface(stream, 120_000, 30_000)?.visibility).toBe('private')
  })
})

describe('the turn loop', () => {
  it('runs a tool, answers, records the turn, and replays it', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ text: '', toolCalls: [{ callId: 'c1', name: 'lookup', arguments: '{}' }] })
      .mockResolvedValueOnce({ text: 'found it', toolCalls: [] })

    const recorded: string[] = []
    const result = await runTurn('where is the config', {
      send,
      tools: [{ name: 'lookup', run: async () => 'config.json' }],
      memory: { recall: async () => [], record: async ({ text }) => { recorded.push(text) } },
    })

    expect(result.text).toBe('found it')
    expect(result.state.finished).toBe('ok')
    expect(recorded).toEqual(['found it'])
    expect(replay(result.record).matches).toBe(true)
  })

  it('keeps a question answered even when tired', async () => {
    const send = vi.fn().mockResolvedValue({ text: 'it is 3pm', toolCalls: [] })
    const result = await runTurn('what time is it', { send, tools: [] })
    expect(result.text).toBe('it is 3pm')
    expect(replay(result.record).matches).toBe(true)
  })
})

describe('handing work off', () => {
  const tired: Drives = { fatigue: 95, boredom: 0, curiosity: 0, focus: 0 }
  const persona = { tidiness: 0.9, patience: 0.3 }
  const chore = `${Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? '\t' : '') + 'x'.repeat(150)).join('\n')}\n整理成表格`

  it('says something and queues the task', () => {
    const decision = evaluateRefusal(createRefusalState(), {
      text: chore,
      traits: inferRequestTraits(chore),
      persona,
      drives: tired,
      now: 1_000,
    })

    expect(decision.handoff).toBe(true)
    expect(decision.message).toBeTruthy()
    expect(decision.task).toBe(chore)
  })

  it('does the same chore herself when asked twice', () => {
    const first = evaluateRefusal(createRefusalState(), {
      text: chore,
      traits: inferRequestTraits(chore),
      persona,
      drives: tired,
      now: 1_000,
    })
    const second = evaluateRefusal(first.state, {
      text: chore,
      traits: inferRequestTraits(chore),
      persona,
      drives: first.drives,
      now: 2_000,
    })

    expect(second.handoff).toBe(false)
    expect(second.reason).toBe('insisted')
  })

  it('never hands off a long messy question', () => {
    const question = `${'这句很长的问题 '.repeat(300)}\n为什么？`
    const decision = evaluateRefusal(createRefusalState(), {
      text: question,
      traits: inferRequestTraits(question),
      persona,
      drives: tired,
      now: 1_000,
    })
    expect(decision.handoff).toBe(false)
  })
})

describe('what the model reads', () => {
  it('gets a state line only when there is something to say', () => {
    const calm = renderStateLine({ drives: { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 } })
    const tired = renderStateLine({ drives: { fatigue: 80, boredom: 20, curiosity: 0, focus: 10 } })

    expect(calm).toBe('')
    expect(tired).toContain('very tired')
    // No brackets, no key=value, no system-looking id: nothing to mirror back.
    expect(tired).not.toMatch(/[[\]{}]/)
  })

  it('recovers fatigue but keeps the rest of the day', () => {
    const before: Drives = { fatigue: 50, boredom: 30, curiosity: 20, focus: 40 }
    const after = restDrives(before, 2 * 3_600_000)
    expect(after.fatigue).toBeLessThan(before.fatigue)
  })
})
