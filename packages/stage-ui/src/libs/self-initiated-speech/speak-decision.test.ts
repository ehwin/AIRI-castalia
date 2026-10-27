import type { AutonomyInput, AutonomyPolicy, SpeakPolicyName } from './speak-decision'

import { describe, expect, it } from 'vitest'

import { AUTONOMY_POLICY_DEFAULTS, SPEAK_POLICIES } from './speak-decision'

const policyNames = Object.keys(SPEAK_POLICIES) as SpeakPolicyName[]
const baseTime = 1_000_000
/** Calm in VAD terms. The store saves arousal from -1 to 1. */
const CALM = -1
const EXCITED = 1

function createPolicy(overrides: Partial<AutonomyPolicy> = {}): AutonomyPolicy {
  return { ...AUTONOMY_POLICY_DEFAULTS, random: () => 0, ...overrides }
}

function createInput(overrides: Partial<AutonomyInput> = {}): AutonomyInput {
  return {
    now: baseTime,
    lastSpokeAt: null,
    lastUserAt: null,
    energy: 100,
    desire: 'finish the song',
    arousal: 0,
    relationshipDepth: 1,
    ...overrides,
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

interface Scenario {
  name: string
  energy: number
  arousal: number
  desire: string
}

/**
 * The scenarios behind the measurement table in the report. The seed and the
 * parameters live here so that the numbers can be replayed.
 */
const measuredScenarios: Scenario[] = [
  { name: 'idle', energy: 80, arousal: -0.6, desire: '' },
  { name: 'restless', energy: 80, arousal: 0.8, desire: '' },
  { name: 'occupied', energy: 80, arousal: -0.6, desire: 'finish the song' },
  { name: 'tired', energy: 30, arousal: -0.6, desire: 'finish the song' },
  { name: 'flat', energy: 0, arousal: -0.6, desire: 'finish the song' },
]

/** Runs policy ticks at one second and returns the time of each utterance. */
function simulate(
  name: SpeakPolicyName,
  ticks: number,
  seed: number,
  scenario: Scenario = { name: 'default', energy: 80, arousal: 0.6, desire: 'finish the song' },
  overrides: Partial<AutonomyInput> = {},
): number[] {
  const policy = createPolicy({ random: createSeededRandom(seed) })
  const decide = SPEAK_POLICIES[name]
  const spokeAt: number[] = []
  let lastSpokeAt: number | null = null

  for (let tick = 0; tick < ticks; tick += 1) {
    const now = tick * 1000
    const input = createInput({
      now,
      lastSpokeAt,
      energy: scenario.energy,
      arousal: scenario.arousal,
      desire: scenario.desire,
      ...overrides,
    })
    if (decide(input, policy).speak) {
      spokeAt.push(now)
      lastSpokeAt = now
    }
  }

  return spokeAt
}

describe.each(policyNames)('%s', (name) => {
  const decide = SPEAK_POLICIES[name]

  it('stays silent while the cooldown runs', () => {
    const decision = decide(createInput({ lastSpokeAt: baseTime - 1000, arousal: EXCITED }), createPolicy())
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('stays silent with energy at the floor', () => {
    const decision = decide(
      createInput({ energy: AUTONOMY_POLICY_DEFAULTS.energyFloor, lastSpokeAt: baseTime - 600_000, arousal: EXCITED }),
      createPolicy(),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('low-energy')
  })

  it('stays silent right after an owner message', () => {
    const decision = decide(
      createInput({ lastSpokeAt: baseTime - 600_000, lastUserAt: baseTime - 1000, arousal: EXCITED }),
      createPolicy(),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('user-recent')
  })

  it('speaks when every gate passes', () => {
    const decision = decide(createInput({ lastSpokeAt: baseTime - 600_000, arousal: EXCITED }), createPolicy())
    expect(decision.speak).toBe(true)
    expect(decision.reason).toBe('speak')
  })

  it('keeps the rate limit right after speaking', () => {
    const policy = createPolicy()
    expect(decide(createInput({ lastSpokeAt: null, arousal: CALM }), policy).speak).toBe(true)

    const second = decide(
      createInput({ now: baseTime + policy.cooldownMs - 1, lastSpokeAt: baseTime, arousal: CALM }),
      policy,
    )
    expect(second.speak).toBe(false)
  })

  it('reports an urge between zero and one', () => {
    const cases = [
      createInput({ lastSpokeAt: null, energy: 0, arousal: CALM, desire: '' }),
      createInput({ lastSpokeAt: baseTime - 1, energy: 100, arousal: EXCITED }),
      createInput({ lastSpokeAt: baseTime - 10_000, energy: 55, arousal: -0.2, desire: '' }),
      createInput({ lastSpokeAt: baseTime - 600_000, energy: 20, arousal: CALM, desire: 'rest' }),
    ]

    for (const input of cases) {
      const decision = decide(input, createPolicy())
      expect(Number.isFinite(decision.urge)).toBe(true)
      expect(decision.urge).toBeGreaterThanOrEqual(0)
      expect(decision.urge).toBeLessThanOrEqual(1)
    }
  })

  it('refuses a non-finite drive instead of speaking', () => {
    for (const input of [
      createInput({ energy: Number.NaN, lastSpokeAt: baseTime - 600_000 }),
      createInput({ now: Number.NaN, lastSpokeAt: baseTime - 600_000 }),
      createInput({ arousal: Number.NaN, lastSpokeAt: baseTime - 600_000 }),
      createInput({ lastSpokeAt: Number.NaN }),
      createInput({ relationshipDepth: Number.NaN, lastSpokeAt: baseTime - 600_000 }),
    ]) {
      const decision = decide(input, createPolicy())
      expect(decision.speak).toBe(false)
      expect(decision.reason).toBe('input-invalid')
    }
  })

  it('refuses a broken policy instead of speaking', () => {
    const longIdle = { lastSpokeAt: baseTime - 600_000 }
    for (const policy of [
      createPolicy({ cooldownMs: 0 }),
      createPolicy({ idleChatterFactor: 0 }),
      createPolicy({ baseChance: 0 }),
      createPolicy({ userGraceMs: -1 }),
    ]) {
      const decision = decide(createInput(longIdle), policy)
      expect(decision.speak).toBe(false)
      expect(decision.reason).toBe('policy-invalid')
    }
  })

  it('treats a clock that moves backwards as no wait at all', () => {
    const decision = decide(
      createInput({ now: baseTime - 5000, lastSpokeAt: baseTime, arousal: EXCITED }),
      createPolicy({ random: () => 0 }),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('cooldown')
  })

  it('speaks at least once in ten minutes of ticks', () => {
    expect(simulate(name, 600, 12345).length).toBeGreaterThanOrEqual(1)
  })

  it('keeps every silence at least a third of a cooldown long', () => {
    const spokeAt = simulate(name, 600, 12345)
    const shortest = Math.floor(AUTONOMY_POLICY_DEFAULTS.cooldownMs / 3)
    for (let index = 1; index < spokeAt.length; index += 1) {
      expect(spokeAt[index]! - spokeAt[index - 1]!).toBeGreaterThanOrEqual(shortest)
    }
  })

  it('stays within a sane utterance count for ten minutes', () => {
    expect(simulate(name, 600, 999).length).toBeLessThanOrEqual(20)
  })

  it('replays one exact tick sequence', () => {
    const first = simulate(name, 120, 7)
    expect(first.length).toBeGreaterThanOrEqual(1)
    expect(simulate(name, 120, 7)).toEqual(first)
  })
})

describe('shared gates', () => {
  it('lets the owner grace expire', () => {
    const decision = SPEAK_POLICIES['hybrid-drive'](
      createInput({
        lastSpokeAt: baseTime - 600_000,
        lastUserAt: baseTime - AUTONOMY_POLICY_DEFAULTS.userGraceMs,
        arousal: EXCITED,
      }),
      createPolicy(),
    )
    expect(decision.speak).toBe(true)
  })
})

describe('policy differences', () => {
  it('keeps the desire policy silent when no desire is open', () => {
    const decision = SPEAK_POLICIES['desire-pressure'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: EXCITED }),
      createPolicy(),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('no-drive')
  })

  it('treats a whitespace desire as no desire', () => {
    const decision = SPEAK_POLICIES['desire-pressure'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '   ', arousal: EXCITED }),
      createPolicy(),
    )
    expect(decision.reason).toBe('no-drive')
  })

  it('keeps the urge when it refuses for no drive', () => {
    const decision = SPEAK_POLICIES['desire-pressure'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: EXCITED }),
      createPolicy(),
    )
    expect(decision.urge).toBe(1)
  })

  it('lets the budget policy speak without a desire', () => {
    const decision = SPEAK_POLICIES['energy-budget'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: EXCITED }),
      createPolicy(),
    )
    expect(decision.speak).toBe(true)
  })

  it('keeps the budget policy silent in a slack, low drive state', () => {
    const decision = SPEAK_POLICIES['energy-budget'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: CALM, energy: 30 }),
      createPolicy(),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('no-drive')
  })

  it('loses the timer roll when the chance fails', () => {
    const decision = SPEAK_POLICIES['idle-timer'](
      createInput({ lastSpokeAt: baseTime - 600_000, arousal: EXCITED }),
      createPolicy({ random: () => 0.9 }),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('roll-lost')
  })

  it('loses the budget roll when the urge is below the chance', () => {
    const decision = SPEAK_POLICIES['energy-budget'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', energy: 60, arousal: CALM }),
      createPolicy({ random: () => 0.9 }),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('roll-lost')
  })

  it('loses the hybrid roll when idle chatter is not lucky', () => {
    const decision = SPEAK_POLICIES['hybrid-drive'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: CALM }),
      createPolicy({ random: () => 0.9 }),
    )
    expect(decision.speak).toBe(false)
    expect(decision.reason).toBe('roll-lost')
  })

  it('skips the roll when a desire is open', () => {
    const decision = SPEAK_POLICIES['hybrid-drive'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: 'finish the song', arousal: CALM }),
      createPolicy({ random: () => 1 }),
    )
    expect(decision.speak).toBe(true)
  })

  it('waits longer for the desire policy when energy drops', () => {
    const rested = SPEAK_POLICIES['desire-pressure'](
      createInput({ lastSpokeAt: baseTime - 70_000, energy: 100, arousal: CALM }),
      createPolicy(),
    )
    const tired = SPEAK_POLICIES['desire-pressure'](
      createInput({ lastSpokeAt: baseTime - 70_000, energy: 30, arousal: CALM }),
      createPolicy(),
    )
    expect(rested.speak).toBe(true)
    expect(tired.speak).toBe(false)
  })

  it('lets arousal shorten the wait for the timer policy', () => {
    const input = createInput({ lastSpokeAt: baseTime - 45_000 })
    expect(SPEAK_POLICIES['idle-timer']({ ...input, arousal: CALM }, createPolicy()).speak).toBe(false)
    expect(SPEAK_POLICIES['idle-timer']({ ...input, arousal: EXCITED }, createPolicy()).speak).toBe(true)
  })

  it('tells a calm arousal apart from a neutral one', () => {
    const calm = SPEAK_POLICIES['energy-budget'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: CALM, energy: 60 }),
      createPolicy(),
    )
    const neutral = SPEAK_POLICIES['energy-budget'](
      createInput({ lastSpokeAt: baseTime - 600_000, desire: '', arousal: 0, energy: 60 }),
      createPolicy(),
    )
    expect(calm.urge).not.toBeCloseTo(neutral.urge)
  })

  it('lets the hybrid policy speak sooner in a deep relationship', () => {
    const shallow = SPEAK_POLICIES['hybrid-drive'](
      createInput({ lastSpokeAt: baseTime - 90_000, desire: '', arousal: CALM, energy: 100, relationshipDepth: 1 }),
      createPolicy(),
    )
    const deep = SPEAK_POLICIES['hybrid-drive'](
      createInput({ lastSpokeAt: baseTime - 90_000, desire: '', arousal: CALM, energy: 100, relationshipDepth: 4 }),
      createPolicy(),
    )
    expect(shallow.speak).toBe(false)
    expect(deep.speak).toBe(true)
  })

  it('keeps the hybrid policy apart from the desire policy in a deep relationship', () => {
    const input = createInput({
      lastSpokeAt: baseTime - 45_000,
      desire: 'finish the song',
      arousal: CALM,
      energy: 100,
      relationshipDepth: 4,
    })
    expect(SPEAK_POLICIES['desire-pressure'](input, createPolicy()).speak).toBe(false)
    expect(SPEAK_POLICIES['hybrid-drive'](input, createPolicy()).speak).toBe(true)
  })

  it('does not collapse the policies into one behavior', () => {
    const input = createInput({ lastSpokeAt: baseTime - 120_000, desire: '', arousal: 0, energy: 90 })
    const reasons = policyNames.map(name => SPEAK_POLICIES[name](input, createPolicy()).speak)
    expect(new Set(reasons).size).toBeGreaterThan(1)
  })
})

describe('measured scenarios', () => {
  it('measures utterances over ten simulated minutes', () => {
    for (const name of policyNames) {
      for (const scenario of measuredScenarios) {
        const spokeAt = simulate(name, 600, 20261027, scenario)
        expect(spokeAt.length).toBeGreaterThanOrEqual(0)
        expect(spokeAt.length).toBeLessThanOrEqual(20)
      }
    }
  })

  it('keeps the hybrid policy sensitive to every drive', () => {
    const counts = measuredScenarios.map(scenario => simulate('hybrid-drive', 600, 20261027, scenario).length)
    const [idle, restless, occupied, tired, flat] = counts as [number, number, number, number, number]
    expect(flat).toBe(0)
    expect(restless).toBeGreaterThan(idle)
    expect(occupied).toBeGreaterThan(idle)
    expect(tired).toBeLessThan(occupied)
  })
})

describe('policy invariants over randomized inputs', () => {
  it('never speaks below the energy floor and always clamps the urge', () => {
    const random = createSeededRandom(4242)

    for (let index = 0; index < 2000; index += 1) {
      const input = createInput({
        lastSpokeAt: random() < 0.2 ? null : baseTime - Math.floor(random() * 900_000),
        lastUserAt: random() < 0.3 ? baseTime - Math.floor(random() * 60_000) : null,
        energy: Math.floor(random() * 101),
        desire: random() < 0.3 ? '' : random() < 0.5 ? '   ' : 'something worth saying',
        arousal: random() * 2 - 1,
        relationshipDepth: 1 + Math.floor(random() * 4),
      })

      for (const name of policyNames) {
        const decision = SPEAK_POLICIES[name](input, createPolicy({ random }))
        expect(Number.isFinite(decision.urge)).toBe(true)
        expect(decision.urge).toBeGreaterThanOrEqual(0)
        expect(decision.urge).toBeLessThanOrEqual(1)
        if (input.energy <= AUTONOMY_POLICY_DEFAULTS.energyFloor) {
          expect(decision.speak).toBe(false)
        }
        if (decision.speak) {
          expect(input.energy).toBeGreaterThan(AUTONOMY_POLICY_DEFAULTS.energyFloor)
        }
      }
    }
  })

  it('respects the cooldown across randomized tick streams', () => {
    const random = createSeededRandom(31337)

    for (const name of policyNames) {
      const policy = createPolicy({ random, cooldownMs: 10_000 })
      const decide = SPEAK_POLICIES[name]
      const spokeAt: number[] = []
      let lastSpokeAt: number | null = null

      for (let tick = 0; tick < 3000; tick += 1) {
        const now = tick * 500
        const decision = decide(createInput({
          now,
          lastSpokeAt,
          lastUserAt: random() < 0.1 ? now - 5000 : null,
          energy: 90,
          arousal: random() * 2 - 1,
          desire: random() < 0.3 ? '' : 'something worth saying',
        }), policy)

        if (decision.speak) {
          spokeAt.push(now)
          lastSpokeAt = now
        }
      }

      expect(spokeAt.length).toBeGreaterThan(0)
      const shortest = Math.floor(policy.cooldownMs / 3)
      for (let index = 1; index < spokeAt.length; index += 1) {
        expect(spokeAt[index]! - spokeAt[index - 1]!).toBeGreaterThanOrEqual(shortest)
      }
    }
  })
})
