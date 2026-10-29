import type { RelationshipEvidence, RelationshipGatePolicy, RelationshipStage } from './relationship-gate'

import { describe, expect, it } from 'vitest'

import {
  countEvidence,
  DAY_MS,
  decideRelationshipStage,
  pruneEvidence,
  RELATIONSHIP_GATE_DEFAULTS,
} from './relationship-gate'

const HOUR = 3_600_000
/** A fixed instant, so every case reads the same clock. */
const START = new Date(2026, 9, 28, 12, 0, 0).getTime()
const policy = (over: Partial<RelationshipGatePolicy> = {}): RelationshipGatePolicy => ({ ...RELATIONSHIP_GATE_DEFAULTS, ...over })
const disclosure = (id: string, at: number): RelationshipEvidence => ({ eventId: id, at, kind: 'disclosure' })
function decide(previousStage: RelationshipStage, evidence: readonly RelationshipEvidence[], over: Partial<Parameters<typeof decideRelationshipStage>[0]> = {}) {
  return decideRelationshipStage({ previousStage, evidence, explicit: { correction: false, boundaryStop: false }, now: START, promotedAt: null, ...over })
}

describe('relationship gate', () => {
  it('promotes when every criterion of the next level holds', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS), disclosure('b', START - DAY_MS)]
    expect(decide(1, evidence)).toMatchObject({ stage: 2, reason: 'promoted', promotedAt: START })
  })

  it('needs both criteria, never a weighted total', () => {
    // Six disclosures, all on one day: the count passes, the day span does not.
    const oneDay = Array.from({ length: 6 }, (_, index) => disclosure(`d${index}`, START - 2 * HOUR + index * 1_000))
    expect(countEvidence(oneDay)).toMatchObject({ disclosures: 6, distinctDays: 1 })
    expect(decide(1, oneDay)).toMatchObject({ stage: 1, reason: 'held' })

    // Two days, one disclosure: the day span passes, the count does not.
    expect(decide(1, [disclosure('only', START - DAY_MS)])).toMatchObject({ stage: 1, reason: 'held' })
  })

  it('promotes one level per decision, even with evidence for the deepest level', () => {
    const evidence = Array.from({ length: 8 }, (_, index) => disclosure(`d${index}`, START - (8 - index) * DAY_MS))
    expect(decide(1, evidence).stage).toBe(2)
  })

  it('waits for the promotion cooldown', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS), disclosure('b', START - DAY_MS)]
    expect(decide(1, evidence, { promotedAt: START - HOUR })).toMatchObject({ stage: 1, reason: 'held' })
    expect(decide(1, evidence, { promotedAt: START - 48 * HOUR })).toMatchObject({ stage: 2, reason: 'promoted' })
  })

  it('waits until the evidence spans the minimum time', () => {
    // Two days, but both inside the last hour of the window.
    const evidence = [disclosure('a', START - HOUR), disclosure('b', START - HOUR / 2)]
    expect(countEvidence(evidence).distinctDays).toBe(1)
    // Two calendar days, but only one hour apart: the day span passes and the
    // minimum span does not, so this case isolates the span rule.
    const midnight = new Date(2026, 9, 28, 0, 30, 0).getTime()
    const justBefore = midnight - HOUR
    const bridging = [disclosure('c', justBefore), disclosure('d', midnight)]
    expect(countEvidence(bridging).distinctDays).toBe(2)
    expect(decide(1, bridging, { now: midnight }).reason).toBe('held')
    const spanning = [disclosure('e', START - 25 * HOUR), disclosure('f', START - HOUR)]
    expect(decide(1, spanning).reason).toBe('promoted')
  })

  it('drops one level on the owner own act, with no hold bar and no grace period', () => {
    // A full bar for level 3, promoted a minute ago: the correction still lands.
    const evidence = Array.from({ length: 6 }, (_, index) => disclosure(`d${index}`, START - (6 - index) * DAY_MS))
    const decision = decide(3, evidence, {
      explicit: { correction: true, boundaryStop: false },
      promotedAt: START - 60_000,
    })
    expect(decision).toMatchObject({ stage: 2, reason: 'explicit' })
    expect(decide(3, evidence, { explicit: { correction: false, boundaryStop: true } })).toMatchObject({ stage: 2, reason: 'explicit' })
  })

  it('never drops below the first level', () => {
    expect(decide(1, [], { explicit: { correction: true, boundaryStop: true } }).stage).toBe(1)
  })

  it('drops one level at a time for an explicit act', () => {
    const twoAtOnce = policy({ explicitDropLevels: 2 })
    expect(decide(4, [], { explicit: { correction: true, boundaryStop: false }, policy: twoAtOnce }).stage).toBe(2)
  })

  it('keeps a level while the criteria stay above the hold bar', () => {
    // Level 2 asks for two disclosures over two days. One day of the two is
    // enough to hold it: two of two criteria stay above 0.9 of the bar.
    const evidence = [disclosure('a', START - 2 * DAY_MS), disclosure('b', START - DAY_MS)]
    expect(decide(2, evidence, { promotedAt: START - 30 * DAY_MS })).toMatchObject({ stage: 2, reason: 'held' })
  })

  it('decays a level once the criteria fall below the hold bar', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS)]
    expect(decide(2, evidence, { promotedAt: START - 30 * DAY_MS })).toMatchObject({ stage: 1, reason: 'decayed' })
  })

  it('holds a level through the grace period after a promotion', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS)]
    expect(decide(2, evidence, { promotedAt: START - 2 * DAY_MS })).toMatchObject({ stage: 2, reason: 'held' })
    expect(decide(2, evidence, { promotedAt: START - 8 * DAY_MS })).toMatchObject({ stage: 1, reason: 'decayed' })
  })

  it('leaves a level alone when no evidence was ever recorded', () => {
    // State stored before this gate existed carries counters but no list. That
    // reads as "unknown", not as "the relationship faded".
    expect(decide(3, [])).toMatchObject({ stage: 3, reason: 'held' })
    expect(decide(4, [], { promotedAt: START - 100 * DAY_MS })).toMatchObject({ stage: 4, reason: 'held' })
    // A correction still lands, because that is the owner speaking, not a statistic.
    expect(decide(3, [], { explicit: { correction: true, boundaryStop: false } })).toMatchObject({ stage: 2, reason: 'explicit' })
  })

  it('counts one event once, however often it appears', () => {
    const repeated = [disclosure('same', START - DAY_MS), disclosure('same', START - HOUR), disclosure('same', START)]
    expect(countEvidence(pruneEvidence(repeated, START, policy())).disclosures).toBe(1)
  })

  it('drops evidence that left the window, and keeps the newest row', () => {
    const old = [disclosure('ancient', START - 200 * DAY_MS), disclosure('fresh', START - DAY_MS)]
    const pruned = pruneEvidence(old, START, policy())
    expect(pruned.map(item => item.eventId)).toEqual(['fresh'])
    // A companion that talks twice a year still counts what it has.
    expect(pruneEvidence([disclosure('only-old', START - 200 * DAY_MS)], START, policy())).toHaveLength(1)
  })

  it('ignores a row without an id or without a time', () => {
    const rows: RelationshipEvidence[] = [
      { eventId: '', at: START, kind: 'disclosure' },
      { eventId: 'no-time', at: Number.NaN, kind: 'disclosure' },
      { eventId: 'good', at: START, kind: 'disclosure' },
    ]
    expect(pruneEvidence(rows, START, policy()).map(item => item.eventId)).toEqual(['good'])
  })

  it('changes nothing when the policy or the clock is nonsense', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS), disclosure('b', START - DAY_MS)]
    for (const broken of [
      policy({ windowMs: 0 }),
      policy({ hysteresis: 0 }),
      policy({ hysteresis: 2 }),
      policy({ levels: { 2: { disclosures: 0, distinctDays: 2 }, 3: RELATIONSHIP_GATE_DEFAULTS.levels[3], 4: RELATIONSHIP_GATE_DEFAULTS.levels[4] } }),
      policy({ explicitDropLevels: 0 }),
    ]) {
      expect(decide(1, evidence, { policy: broken })).toMatchObject({ stage: 1, reason: 'invalid' })
    }
    expect(decide(3, evidence, { now: Number.NaN })).toMatchObject({ stage: 3, reason: 'invalid' })
  })

  it('changes nothing for a correction when the policy is nonsense', () => {
    const broken = policy({ hysteresis: 0 })
    expect(decide(3, [], { explicit: { correction: true, boundaryStop: true }, policy: broken })).toMatchObject({ stage: 3, reason: 'invalid' })
  })

  it('reports the counted evidence, and the moment it began', () => {
    const evidence = [
      disclosure('a', START - 2 * DAY_MS),
      disclosure('b', START - DAY_MS),
      { eventId: 'b1', at: START - HOUR, kind: 'boundary' } as RelationshipEvidence,
    ]
    const decision = decide(1, evidence)
    expect(decision.counts).toMatchObject({ disclosures: 2, distinctDays: 2, boundaries: 1, corrections: 0 })
    expect(decision.evidenceSince).toBe(START - 2 * DAY_MS)
  })

  it('answers the same decision for the same inputs twice', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS), disclosure('b', START - DAY_MS)]
    expect(decide(1, evidence)).toEqual(decide(1, evidence))
  })

  it('never changes the evidence it reads', () => {
    const evidence = [disclosure('a', START - 2 * DAY_MS), disclosure('b', START - DAY_MS)]
    const snapshot = structuredClone(evidence)
    decide(1, evidence)
    decide(3, evidence, { explicit: { correction: true, boundaryStop: true } })
    expect(evidence).toEqual(snapshot)
  })

  it('reaches the deepest level only after its own bar is earned', () => {
    const sevenDays = Array.from({ length: 6 }, (_, index) => disclosure(`d${index}`, START - (6 - index) * DAY_MS))
    // Six disclosures over six days is not level 4: it asks for seven days.
    expect(countEvidence(sevenDays).distinctDays).toBe(6)
    const eightDays = [...sevenDays, disclosure('d6', START - 8 * DAY_MS)]
    expect(countEvidence(eightDays).distinctDays).toBe(7)
    expect(decide(3, eightDays, { promotedAt: START - 30 * DAY_MS })).toMatchObject({ stage: 4, reason: 'promoted' })
  })
})
