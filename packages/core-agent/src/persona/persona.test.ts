import { describe, expect, it } from 'vitest'

import type { Drives } from '../mind/drives'

import { defaultReturnConfig, planReturn } from './absence'
import { applyFriction, assessFriction, defaultFrictionConfig } from './friction'
import { createStream, record, recent, sharedRatio, surface } from './inner-stream'

const calm: Drives = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }

describe('inner stream', () => {
  it('keeps every thought, shared or not', () => {
    let stream = createStream()
    stream = record(stream, { id: 'a', at: 1, text: 'a thought', visibility: 'private' })
    stream = record(stream, { id: 'b', at: 2, text: 'said aloud', visibility: 'shared' })
    expect(stream.entries).toHaveLength(2)
  })

  it('drops the oldest entry past the cap', () => {
    let stream = createStream(2)
    stream = record(stream, { id: '1', at: 1, text: 'one', visibility: 'private' })
    stream = record(stream, { id: '2', at: 2, text: 'two', visibility: 'private' })
    stream = record(stream, { id: '3', at: 3, text: 'three', visibility: 'private' })
    expect(stream.entries.map(entry => entry.id)).toEqual(['2', '3'])
  })

  it('surfaces a private thought only when it is old enough', () => {
    let stream = createStream()
    stream = record(stream, { id: 'a', at: 100_000, text: 'wondering', visibility: 'private' })
    expect(surface(stream, 110_000, 30_000)).toBeUndefined()
    expect(surface(stream, 140_000, 30_000)?.text).toBe('wondering')
  })

  it('never surfaces something it already said out loud', () => {
    let stream = createStream()
    stream = record(stream, { id: 'a', at: 1, text: 'said', visibility: 'shared' })
    expect(surface(stream, 10_000_000, 0)).toBeUndefined()
  })

  it('keeps most thoughts private', () => {
    let stream = createStream()
    for (let i = 0; i < 9; i++)
      stream = record(stream, { id: `p${i}`, at: i, text: 'private', visibility: 'private' })
    stream = record(stream, { id: 's', at: 9, text: 'shared', visibility: 'shared' })
    expect(sharedRatio(stream)).toBeCloseTo(0.1, 5)
  })

  it('returns the newest thoughts first', () => {
    let stream = createStream()
    stream = record(stream, { id: 'a', at: 1, text: 'one', visibility: 'private' })
    stream = record(stream, { id: 'b', at: 2, text: 'two', visibility: 'private' })
    expect(recent(stream, 1).map(entry => entry.id)).toEqual(['b'])
  })
})

describe('absence', () => {
  it('recovers fatigue while away', () => {
    const report = planReturn({ awayMs: 8 * 3_600_000, drives: { ...calm, fatigue: 100 }, journal: [], hourOfDay: 9 })
    expect(report.slept).toBe(true)
    expect(report.drives.fatigue).toBe(0)
  })

  it('says nothing when nothing happened', () => {
    const report = planReturn({ awayMs: 3_600_000, drives: calm, journal: [], hourOfDay: 9 })
    expect(report.opening).toBeUndefined()
  })

  it('opens with the last thing it did, not a greeting', () => {
    const report = planReturn({
      awayMs: 8 * 3_600_000,
      drives: { ...calm, fatigue: 40 },
      journal: [
        { id: 'a', at: 1, text: 'archived two notes', visibility: 'private' },
        { id: 'b', at: 2, text: 'the window was cold', visibility: 'private' },
      ],
      hourOfDay: 8,
    })
    expect(report.opening).toBe('the window was cold')
  })

  it('treats a short pause as waking up, not sleeping', () => {
    const report = planReturn({ awayMs: 10 * 60_000, drives: calm, journal: [], hourOfDay: 15 })
    expect(report.slept).toBe(defaultReturnConfig.sleepMs <= 10 * 60_000)
  })
})

describe('friction', () => {
  const tidy = { tidiness: 0.9, patience: 0.3 }

  it('accepts a clean, short, interesting task', () => {
    const result = assessFriction({ tedium: 0, mess: 0, durationMin: 3 }, tidy, calm)
    expect(result.stance).toBe('accept')
    expect(result.driveDelta).toEqual({})
  })

  it('complains about a messy task from a tidy character', () => {
    const result = assessFriction({ tedium: 0.2, mess: 1, durationMin: 5 }, tidy, calm)
    expect(result.stance).toBe('grumble')
    expect(result.reason).toContain('mess')
  })

  it('refuses only when everything is against it', () => {
    // A single bad dimension earns a complaint. Refusal needs a pile-up.
    const result = assessFriction(
      { tedium: 1, mess: 1, durationMin: 90 },
      tidy,
      { ...calm, fatigue: 90 },
    )
    expect(result.stance).toBe('refuse')
    expect(result.score).toBeGreaterThan(defaultFrictionConfig.refuseAt)
  })

  it('complains before it refuses', () => {
    const result = assessFriction({ tedium: 0.9, mess: 0.2, durationMin: 10 }, tidy, calm)
    expect(['grumble', 'refuse']).toContain(result.stance)
    expect(result.score).toBeGreaterThan(0)
  })

  it('lets fatigue turn an acceptable task into a complaint', () => {
    const request = { tedium: 0.4, mess: 0.3, durationMin: 20 }
    const fresh = assessFriction(request, tidy, calm)
    const tired = assessFriction(request, tidy, { ...calm, fatigue: 95 })
    expect(tired.score).toBeGreaterThan(fresh.score)
    expect(['accept', 'grumble']).toContain(fresh.stance)
    expect(tired.stance).not.toBe('accept')
  })

  it('charges fatigue for the work it did accept', () => {
    const result = assessFriction({ tedium: 0.2, mess: 0.2, durationMin: 4 }, tidy, calm)
    const next = applyFriction({ ...calm, fatigue: 50 }, result)
    expect(next.fatigue).toBe(50 + (result.driveDelta.fatigue ?? 0))
  })

  it('never pushes a gauge past 100', () => {
    const result = assessFriction({ tedium: 1, mess: 1, durationMin: 90 }, tidy, calm)
    const next = applyFriction({ ...calm, fatigue: 99 }, result)
    expect(next.fatigue).toBeLessThanOrEqual(100)
  })

  it('uses the configured thresholds', () => {
    const lenient = { grumbleAt: 10, refuseAt: 20 }
    const result = assessFriction({ tedium: 1, mess: 1, durationMin: 90 }, tidy, calm, lenient)
    expect(result.stance).toBe('accept')
    expect(defaultFrictionConfig.refuseAt).toBe(1.25)
  })
})
