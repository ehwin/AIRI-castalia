import type { Drives } from '../mind/drives'

import { describe, expect, it } from 'vitest'

import { composeThought, defaultLaneConfig } from './background-lane'
import { createStream, record, sharedRatio } from './inner-stream'
import { renderStateLine } from './state-line'

const calm: Drives = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }

describe('background lane', () => {
  it('says nothing without observations', () => {
    expect(composeThought({ now: 1, drives: { ...calm, boredom: 90 }, observations: [], roll: 0 })).toBeUndefined()
  })

  it('says nothing while calm', () => {
    const thought = composeThought({
      now: 1,
      drives: calm,
      observations: ['the build failed'],
      roll: 0,
    })
    expect(thought).toBeUndefined()
  })

  it('says nothing when the roll misses', () => {
    const thought = composeThought({
      now: 1,
      drives: { ...calm, boredom: 50 },
      observations: ['the build failed'],
      roll: 0.9,
    })
    expect(thought).toBeUndefined()
  })

  it('keeps its thought private', () => {
    const thought = composeThought({
      now: 1_000,
      drives: { ...calm, boredom: 50 },
      observations: ['the build failed'],
      roll: 0.05,
    })
    expect(thought).toMatchObject({ visibility: 'private', at: 1_000 })
    expect(thought?.text).toContain('noticed:')
  })

  it('picks the same observation for the same roll', () => {
    const input = {
      now: 1,
      drives: { ...calm, boredom: 50 },
      observations: ['a', 'b', 'c', 'd'],
      roll: 0.1,
    }
    expect(composeThought(input)?.text).toBe(composeThought(input)?.text)
  })

  it('spreads picks across the observations', () => {
    const base = { now: 1, drives: { ...calm, boredom: 50 }, observations: ['a', 'b', 'c', 'd'] }
    const picks = new Set(
      [0.01, 0.07, 0.13, 0.19].map(roll => composeThought({ ...base, roll })?.text),
    )
    expect(picks.size).toBeGreaterThan(1)
  })

  it('keeps the default rate low', () => {
    expect(defaultLaneConfig.chance).toBeLessThanOrEqual(0.3)
  })
})

describe('state line', () => {
  it('says nothing about a calm companion', () => {
    expect(renderStateLine({ drives: calm })).toBe('')
  })

  it('reports fatigue above the threshold', () => {
    expect(renderStateLine({ drives: { ...calm, fatigue: 80 } })).toContain('very tired')
  })

  it('reports a fresh return from a long absence', () => {
    expect(renderStateLine({ drives: calm, slept: true })).toContain('just woke up')
  })

  it('reports something held back', () => {
    expect(renderStateLine({ drives: calm, heldBack: true })).toContain('holding something back')
  })

  it('reads as narration, with no markup to mirror back', () => {
    const line = renderStateLine({ drives: { ...calm, fatigue: 80, boredom: 60 } })
    expect(line).toContain('very tired')
    expect(line).not.toMatch(/[[\]{}<>]/)
    expect(line).not.toContain('=')
  })

  it('stays short enough to repeat every turn', () => {
    const line = renderStateLine({
      drives: { fatigue: 90, boredom: 90, curiosity: 90, focus: 90 },
      slept: true,
      heldBack: true,
    })
    expect(line.length).toBeLessThan(120)
  })
})

describe('the lane is a diary, not chatter', () => {
  it('writes often while bored and never shares a thought', () => {
    let stream = createStream()
    let written = 0

    for (let tick = 0; tick < 160; tick++) {
      const thought = composeThought({
        now: tick * 45_000,
        drives: { fatigue: 0, boredom: 60, curiosity: 0, focus: 0 },
        observations: ['a failed build', 'a green test run'],
        roll: 0.01,
      })
      if (!thought)
        continue
      written++
      stream = record(stream, thought)
    }

    // Roughly one thought every few minutes is a day of thinking, not noise.
    expect(written).toBeGreaterThan(20)
    // None of it is spoken. The user sees one only after asking.
    expect(sharedRatio(stream)).toBe(0)
  })
})
