import { describe, expect, it } from 'vitest'

import { closingFromRun, createRelationalPolicy, inferRelationalSignals, nextClosingRun, renderRelationalPolicyContext, reviewMeaningHypotheses, updateRelationship } from './relational-policy'

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

  // Depth is evidence over time, not a counter. The gate wants the evidence to
  // span at least twelve hours and to land on two separate days, so one long
  // evening of oversharing cannot buy the level that weeks of talking buy.
  it('raises relationship depth one step at a time', () => {
    const first = updateRelationship(undefined, {
      now: 100,
      eventId: 'turn-1',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })
    const second = updateRelationship(first, {
      now: 100 + 25 * 3_600_000,
      eventId: 'turn-2',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })

    expect(first.stage).toBe(1)
    expect(second.stage).toBe(2)
  })

  it('does not raise depth from a burst inside one sitting', () => {
    let state = updateRelationship(undefined, {
      now: 100,
      eventId: 'burst-0',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })
    for (let index = 1; index < 6; index += 1) {
      state = updateRelationship(state, {
        now: 100 + index * 1_000,
        eventId: `burst-${index}`,
        disclosure: 'vulnerable',
        userInvitedDepth: true,
        boundary: 'continue',
        correction: false,
      })
    }

    expect(state.disclosureSignals).toBe(6)
    expect(state.stage).toBe(1)
  })

  it('does not count the same turn twice', () => {
    const first = updateRelationship(undefined, {
      now: 100,
      eventId: 'twice',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })
    const again = updateRelationship(first, {
      now: 100,
      eventId: 'twice',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })

    expect(first.evidence).toHaveLength(1)
    expect(again.evidence).toHaveLength(1)
    expect(again.stage).toBe(1)
  })

  it('counts separate days, not separate turns', () => {
    // Thirteen hours apart, both after midnight on the same day.
    const day = new Date(2026, 9, 28, 1, 0, 0).getTime()
    const first = updateRelationship(undefined, {
      now: day,
      eventId: 'same-day-1',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })
    const second = updateRelationship(first, {
      now: day + 13 * 3_600_000,
      eventId: 'same-day-2',
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
    })

    expect(second.stage).toBe(1)
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

  // A hard week is not a step closer. Before this rule the elevated tier behaved
  // exactly like a calm turn, so a disclosure made during a bad week advanced
  // depth, and the renderer told her to keep exploring the cause.
  it('does not raise depth while the user is having a hard time', () => {
    const first = updateRelationship(undefined, {
      now: 100,
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
      safety: 'elevated',
    })
    const second = updateRelationship(first, {
      now: 200,
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'continue',
      correction: false,
      safety: 'elevated',
    })

    expect(first.stage).toBe(1)
    expect(second.stage).toBe(1)
    expect(second.disclosureSignals).toBe(0)
  })

  it('still backs off during an elevated turn', () => {
    const result = updateRelationship({ stage: 3, disclosureSignals: 6, boundarySignals: 0, lastUpdatedAt: 1 }, {
      now: 100,
      disclosure: 'vulnerable',
      userInvitedDepth: true,
      boundary: 'stop',
      correction: true,
      safety: 'elevated',
    })

    expect(result.stage).toBe(2)
    expect(result.boundarySignals).toBe(1)
  })

  it('cuts probing short in an elevated turn and turns it off in a crisis', () => {
    expect(createRelationalPolicy({ now: 100 }).stability.probing).toBe('normal')
    expect(createRelationalPolicy({ now: 100, safety: 'elevated' }).stability.probing).toBe('reduced')
    expect(createRelationalPolicy({ now: 100, safety: 'crisis' }).stability.probing).toBe('none')

    const elevated = renderRelationalPolicyContext(createRelationalPolicy({ now: 100, safety: 'elevated' }))
    expect(elevated).toContain('having a hard time')
    expect(elevated).toContain('do not dig for the cause')
    expect(elevated).toContain('Do not treat any reading of the user as a fact.')
    // The depth line belongs to calm turns only: printing it here would report a
    // stage that the elevated tier refuses to move.
    expect(elevated).not.toContain('Depth:')
  })

  // A farewell is leaving, not a correction. BOUNDARY_PATTERN matches "不想聊了",
  // so without the downgrade she would announce what she will change while the
  // user is already walking out.
  it('does not count a farewell as a boundary or a repair request', () => {
    const state = updateRelationship(undefined, {
      now: 100,
      eventId: 'turn-bye',
      closing: 'pre-closing',
      boundary: 'stop',
    })

    expect(state.boundarySignals).toBe(0)
    expect(state.evidence ?? []).toEqual([])

    const policy = createRelationalPolicy({ now: 100, closing: 'pre-closing', boundary: 'stop' })
    expect(policy.stability.repairNeeded).toBe(false)
    expect(renderRelationalPolicyContext(policy)).not.toContain('Say what you will change')
  })

  it('reads a farewell from one message, and refuses to read it from a question', () => {
    for (const text of [
      '我得准备学习了',
      '我去洗澡了，先不聊啦',
      '算了不想了，我睡了',
      '不聊了，我得去写了',
      '我先躺着试试能不能睡着',
      '晚安',
      // No verb at all, but a departure mark and short: found in the owner's real turns.
      '今天先这样,明天继续',
      '那我先撤了',
      '就到这儿吧',
    ])
      expect(inferRelationalSignals(text).closing, text).toBe('pre-closing')

    for (const text of [
      '我去做饭了，你想吃什么？',
      '我在学习函数渐近线',
      '睡不着的晚上总是很多',
      '我觉得这个方案还得再想想',
      // Marks that open ordinary sentences, not departures.
      '好了，你别生气',
      '算了，别提了',
      '好的，明天继续吗？',
      // Long enough that it is talking about the evening, not ending it.
      '我今天先这样写一版，明天再继续把剩下那部分内容仔细处理一遍',
    ])
      expect(inferRelationalSignals(text).closing, text).toBe('open')
  })

  it('counts farewells in a row and resets on any other turn', () => {
    // Two in a row is a departure; the count is what turns pre-closing into closed.
    let run = nextClosingRun(0, 'pre-closing')
    expect(run).toBe(1)
    expect(closingFromRun(run, 'pre-closing')).toBe('pre-closing')

    run = nextClosingRun(run, 'pre-closing')
    expect(run).toBe(2)
    expect(closingFromRun(run, 'pre-closing')).toBe('closed')

    // A third farewell stays closed, it does not wrap or overflow.
    run = nextClosingRun(run, 'pre-closing')
    expect(closingFromRun(run, 'pre-closing')).toBe('closed')

    // Any other turn clears the run, so a farewell tomorrow starts from one.
    expect(nextClosingRun(run, 'open')).toBe(0)
    expect(nextClosingRun(0, 'open')).toBe(0)
    // A negative cache value cannot happen, but the counter never goes below zero.
    expect(nextClosingRun(-5, 'pre-closing')).toBe(1)
  })

  it('answers a goodbye instead of asking one more question', () => {
    const rendered = renderRelationalPolicyContext(createRelationalPolicy({
      now: 100,
      safety: 'elevated',
      closing: 'pre-closing',
    }))

    expect(rendered).toContain('ending the conversation')
    // The elevated branch would otherwise hand her "ask at most one short question".
    expect(rendered).not.toContain('Ask at most one short question')
    expect(rendered).not.toContain('having a hard time')
    // The red line survives every branch.
    expect(rendered).toContain('Never use your own feelings')
  })
})
