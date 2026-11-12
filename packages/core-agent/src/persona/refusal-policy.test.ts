import type { Drives } from '../mind/drives'

import { describe, expect, it } from 'vitest'

import { createRefusalState, defaultRefusalPolicy, evaluateRefusal } from './refusal-policy'
import { inferRequestTraits } from './request-traits'

const tired: Drives = { fatigue: 95, boredom: 0, curiosity: 0, focus: 0 }
const fresh: Drives = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }
const persona = { tidiness: 0.9, patience: 0.3 }
const NOW = 1_000_000

function ask(text: string, drives: Drives = tired, now = NOW) {
  return evaluateRefusal(createRefusalState(), {
    text,
    traits: inferRequestTraits(text),
    persona,
    drives,
    now,
  })
}

/** A messy chore whose tail varies, so two of them are different requests. */
const heavy = (tag: string) => `${Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? '\t' : '') + 'x'.repeat(150)).join('\n')}\n整理成表格 ${tag}`
const messyChore = heavy('a')

describe('refusal policy', () => {
  it('never refuses a question, however long and messy', () => {
    const longMessyQuestion = `${'这句很长的问题 '.repeat(300)}\n${'\t'.repeat(5)}为什么？`
    const decision = ask(longMessyQuestion)
    expect(decision.handoff).toBe(false)
    expect(decision.reason).toContain('not a chore')
  })

  it('refuses a heavy chore once when tired', () => {
    const decision = ask(messyChore)
    expect(decision.handoff).toBe(true)
    expect(decision.message).toContain('工程师')
    expect(decision.drives.fatigue).toBeGreaterThan(tired.fatigue - 1)
  })

  it('complies when the owner asks the same thing again', () => {
    const first = ask(messyChore)
    expect(first.handoff).toBe(true)

    const second = evaluateRefusal(first.state, {
      text: messyChore,
      traits: inferRequestTraits(messyChore),
      persona,
      drives: first.drives,
      now: NOW + 1_000,
    })

    expect(second.handoff).toBe(false)
    expect(second.reason).toBe('insisted')
  })

  it('treats a third try as a normal request again', () => {
    const first = ask(messyChore)
    const second = evaluateRefusal(first.state, {
      text: messyChore,
      traits: inferRequestTraits(messyChore),
      persona,
      drives: first.drives,
      now: NOW + 1_000,
    })
    // The owner insisted once. This hour already had its refusal, so the next one complains.
    const third = evaluateRefusal(second.state, {
      text: messyChore,
      traits: inferRequestTraits(messyChore),
      persona,
      drives: second.drives,
      now: NOW + 2_000,
    })
    expect(third.handoff).toBe(false)
    expect(third.reason).toBe('refusal budget spent')
  })

  it('complains instead of refusing once the hourly budget is spent', () => {
    const first = ask(messyChore)
    const other = heavy('b')

    const second = evaluateRefusal(first.state, {
      text: other,
      traits: inferRequestTraits(other),
      persona,
      drives: first.drives,
      now: NOW + 60_000,
    })

    expect(second.handoff).toBe(false)
    expect(second.reason).toBe('refusal budget spent')
  })

  it('refuses again after an hour', () => {
    const first = ask(messyChore)
    const later = evaluateRefusal(first.state, {
      text: heavy('c'),
      traits: inferRequestTraits(heavy('c')),
      persona,
      drives: first.drives,
      now: NOW + 3_700_000,
    })
    expect(later.handoff).toBe(true)
  })

  it('does not refuse when rested', () => {
    const decision = ask(messyChore, fresh)
    expect(decision.handoff).toBe(false)
  })

  it('complains without charging the refusal cost', () => {
    const decision = ask('把这段 JSON 重新格式化一下', { ...tired, fatigue: 50 })
    expect(decision.handoff).toBe(false)
    expect(decision.reason).toBe('grumbled')
    expect(decision.drives.fatigue).toBeGreaterThanOrEqual(50)
  })

  it('exposes the default budget', () => {
    expect(defaultRefusalPolicy.maxPerHour).toBe(1)
    expect(defaultRefusalPolicy.insistWindowMs).toBe(10 * 60_000)
  })
})
