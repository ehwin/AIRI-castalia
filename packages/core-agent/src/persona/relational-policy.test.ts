import { describe, expect, it } from 'vitest'

import { createRelationalPolicy, reviewMeaningHypotheses, updateRelationship } from './relational-policy'

describe('relational policy', () => {
  it('keeps an interpretation as a hypothesis with evidence', () => {
    const result = reviewMeaningHypotheses([{
      id: 'h1',
      text: 'Maybe the refactor is about avoiding future loss of control.',
      evidence: ['User removed the implementation again after tests passed.'],
      confidence: 0.55,
    }], 100)

    expect(result[0]).toMatchObject({ id: 'h1', persistence: 'diary-only', confidence: 0.55 })
    expect(result[0].userCheck).toContain('possible reading')
  })

  it('drops unsupported or user-rejected interpretations', () => {
    const result = reviewMeaningHypotheses([
      { id: 'unsupported', text: 'mind reading', evidence: [], confidence: 0.99 },
      { id: 'rejected', text: 'not this', evidence: ['user said so'], confidence: 0.99 },
    ], 100, ['rejected'])

    expect(result).toEqual([])
  })

  it('does not infer meaning during a crisis', () => {
    expect(reviewMeaningHypotheses([{
      id: 'h1',
      text: 'hidden motive',
      evidence: ['a message'],
      confidence: 1,
    }], 100, [], 'crisis')).toEqual([])
  })

  it('raises relationship depth one step at a time', () => {
    const first = updateRelationship(undefined, {
      now: 100,
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })
    const second = updateRelationship(first, {
      now: 200,
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })

    expect(first.stage).toBe(1)
    expect(second.stage).toBe(2)
  })

  it('does not treat an invitation without disclosure as intimacy', () => {
    const result = updateRelationship(undefined, {
      now: 100,
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })

    expect(result).toMatchObject({ stage: 1, disclosureSignals: 0 })
  })

  it('backs off after a correction or boundary stop', () => {
    const result = updateRelationship({ stage: 3, disclosureSignals: 6, boundarySignals: 0, lastUpdatedAt: 1 }, {
      now: 100,
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'stop',
      correction: true,
    })

    expect(result.stage).toBe(2)
    expect(result.boundarySignals).toBe(1)
  })

  it('allows disagreement only when there is a reason', () => {
    expect(createRelationalPolicy({ now: 100 }).friction.disagreementAllowed).toBe(false)
    expect(createRelationalPolicy({ now: 100, factualConflict: true }).friction).toMatchObject({
      disagreementAllowed: true,
      evidenceRequired: true,
      maxIntensity: 1,
      reason: 'facts',
    })
  })

  it('puts safety before friction', () => {
    const result = createRelationalPolicy({ now: 100, safety: 'crisis', factualConflict: true })
    expect(result.friction).toMatchObject({ disagreementAllowed: false, maxIntensity: 0, reason: 'safety' })
    expect(result.stability.containment).toBe('safety-first')
    expect(result.safety.blockMeaningInference).toBe(true)
  })
})
