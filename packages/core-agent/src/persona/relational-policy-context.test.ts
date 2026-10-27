import { describe, expect, it } from 'vitest'

import { createRelationalPolicy, inferRelationalSignals, renderRelationalPolicyContext, reviewMeaningHypotheses } from './relational-policy'

describe('relational signals', () => {
  it('reads a correction from the user turn', () => {
    expect(inferRelationalSignals('不是这样，我说的是狗').correction).toBe(true)
    expect(inferRelationalSignals('今天天气不错').correction).toBe(false)
  })

  it('reads crisis before anything else', () => {
    const signals = inferRelationalSignals('我真的不想活了')
    expect(signals.safety).toBe('crisis')
  })

  it('reads a boundary and refuses to deepen past it', () => {
    const signals = inferRelationalSignals('别问了，我不想聊这个')
    expect(signals.boundary).toBe('stop')
    expect(signals.userInvitedDepth).toBe(false)
  })

  it('lets an invited disclosure deepen the relationship', () => {
    const signals = inferRelationalSignals('我最近总是在想这件事')
    expect(signals.disclosure).toBe('personal')
    expect(signals.userInvitedDepth).toBe(true)
  })
})

describe('rendered relational policy', () => {
  it('answers safety first in a crisis and blocks motive inference', () => {
    const policy = createRelationalPolicy({
      now: 0,
      safety: 'crisis',
      candidateHypotheses: [{ id: 'h1', text: 'hiding family trouble', evidence: ['late replies'], confidence: 0.9 }],
    })

    const text = renderRelationalPolicyContext(policy)

    expect(policy.safety.blockMeaningInference).toBe(true)
    expect(policy.hypotheses).toEqual([])
    expect(text).toContain('safety first')
    expect(text).not.toContain('hiding family trouble')
    expect(text).not.toContain('Disagree only about')
  })

  it('lowers depth and asks for repair after a correction', () => {
    const relationship = { stage: 3 as const, disclosureSignals: 4, boundarySignals: 0, lastUpdatedAt: 0 }
    const policy = createRelationalPolicy({ now: 1, relationship, correction: true })

    expect(policy.relationship.stage).toBe(2)
    expect(policy.stability.repairNeeded).toBe(true)
    expect(renderRelationalPolicyContext(policy)).toContain('corrected')
  })

  it('keeps low confidence interpretations in the diary', () => {
    const reviewed = reviewMeaningHypotheses([
      { id: 'a', text: 'annoyed with me', evidence: ['short replies'], confidence: 0.4 },
    ], 0)
    expect(reviewed[0].persistence).toBe('diary-only')

    const policy = createRelationalPolicy({
      now: 0,
      candidateHypotheses: [{ id: 'b', text: 'hiding family trouble', evidence: ['late replies'], confidence: 0.9 }],
    })
    // The hypothesis can live in the policy, but it never reaches the prompt text.
    expect(policy.hypotheses).toHaveLength(1)
    expect(renderRelationalPolicyContext(policy)).not.toContain('hiding family trouble')
  })

  it('forbids empty disagreement when no fact or goal conflicts', () => {
    const policy = createRelationalPolicy({ now: 0 })
    expect(policy.friction.disagreementAllowed).toBe(false)
    expect(renderRelationalPolicyContext(policy)).toContain('Do not argue.')
  })
})
