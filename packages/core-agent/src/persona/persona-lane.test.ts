import { describe, expect, it } from 'vitest'

import type { Drives } from '../mind/drives'

import { composeThought, defaultLaneConfig } from './background-lane'
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
    expect(renderStateLine({ drives: { ...calm, fatigue: 80 } })).toContain('tired=high')
  })

  it('reports a fresh return from a long absence', () => {
    expect(renderStateLine({ drives: calm, slept: true })).toContain('just-woke-up')
  })

  it('reports something held back', () => {
    expect(renderStateLine({ drives: calm, heldBack: true })).toContain('holding-something-back')
  })

  it('always tags the line so the model can find it', () => {
    const line = renderStateLine({ drives: { ...calm, boredom: 60 } })
    expect(line.startsWith('[self: ')).toBe(true)
    expect(line.endsWith(']')).toBe(true)
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

describe('the lane stays quiet', () => {
  it('writes nothing when the last thought is recent', () => {
    const thought = composeThought({
      now: 1_000_000,
      drives: { fatigue: 0, boredom: 60, curiosity: 0, focus: 0 },
      observations: ['a failed build'],
      roll: 0.01,
      lastThoughtAt: 1_000_000 - 60_000,
    })
    expect(thought).toBeUndefined()
  })

  it('writes again once the gap passed', () => {
    const thought = composeThought({
      now: 1_000_000,
      drives: { fatigue: 0, boredom: 60, curiosity: 0, focus: 0 },
      observations: ['a failed build'],
      roll: 0.01,
      lastThoughtAt: 1_000_000 - 11 * 60_000,
    })
    expect(thought?.text).toContain('a failed build')
  })
})