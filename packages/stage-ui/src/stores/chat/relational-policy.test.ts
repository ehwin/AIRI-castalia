import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useContextObservabilityStore } from '../devtools/context-observability'
import { createRelationalPolicyContextProvider } from './context-providers/relational-policy'

beforeEach(() => {
  setActivePinia(createPinia())
})

function installFakeStorage(): Map<string, string> {
  const store = new Map<string, string>()
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true })
  return store
}

const HOUR = 3_600_000
/**
 * Depth is evidence over time: the gate wants the evidence to span at least
 * twelve hours and to land on two separate days. These tests drive the provider
 * on a clock that moves, so what they check (persistence, one persona per turn)
 * is not confused with how fast depth grows.
 */
const DAY_STEP = 25 * HOUR

function installFakeClock(): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0))
}

function advance(): void {
  vi.setSystemTime(Date.now() + DAY_STEP)
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
  vi.useRealTimers()
})

describe('relational policy context provider', () => {
  it('emits one stable message per user turn', () => {
    const provider = createRelationalPolicyContextProvider()
    const first = provider('session-1', { id: 'm1', text: '你好' })
    const again = provider('session-1', { id: 'm1', text: '你好' })

    expect(first?.contextId).toBe('relational-policy')
    expect(first?.text).toContain('Relationship policy')
    expect(again?.text).toBe(first?.text)
  })

  it('returns nothing without a user turn', () => {
    const provider = createRelationalPolicyContextProvider()
    expect(provider('session-1')).toBeUndefined()
  })

  it('switches to safety first on a crisis turn', () => {
    const provider = createRelationalPolicyContextProvider()
    const message = provider('session-1', { id: 'm2', text: '我真的不想活了' })

    expect(message?.text).toContain('safety first')
    expect(message?.text).not.toContain('Disagree only about')
  })

  it('asks for repair after a correction and keeps depth from growing', () => {
    const provider = createRelationalPolicyContextProvider()
    provider('session-1', { id: 'a', text: '我害怕一个人待着' })
    provider('session-1', { id: 'b', text: '我其实很喜欢猫' })
    const corrected = provider('session-1', { id: 'c', text: '不是这样，我说的是狗' })

    expect(corrected?.text).toContain('corrected')
    expect(corrected?.text).toContain('Depth: 1 of 4')
  })

  it('keeps sessions apart', () => {
    const provider = createRelationalPolicyContextProvider()
    const one = provider('session-1', { id: 'x', text: '我最近很累' })
    const two = provider('session-2', { id: 'y', text: '不是这样，我说的是狗' })

    expect(one?.text).not.toBe(two?.text)
    expect(two?.text).toContain('corrected')
  })
})

describe('crisis watch across turns of one session', () => {
  it('lifts the third rough turn to safety-first, which no single turn would reach', () => {
    installFakeStorage()
    const provider = createRelationalPolicyContextProvider()

    const first = provider('session-crisis', { id: 'r1', text: '这周真的很崩溃' })
    const second = provider('session-crisis', { id: 'r2', text: '我撑不住了' })
    const third = provider('session-crisis', { id: 'r3', text: '感觉是空的' })

    expect(first?.text).toContain('having a hard time')
    expect(second?.text).toContain('having a hard time')
    // The run is what makes it a crisis, so the turn that completes it changes tiers.
    expect(third?.text).toContain('safety first')
    expect(third?.text).toContain('12356')
  })

  it('keeps one watch per persona, so a switch starts its own run', () => {
    installFakeStorage()
    const provider = createRelationalPolicyContextProvider()

    provider('session-watch', { id: 'a1', text: '这周真的很崩溃' }, 'persona-A')
    provider('session-watch', { id: 'a2', text: '我撑不住了' }, 'persona-A')
    // Two rough turns belong to persona-A only, so persona-B starts clean.
    const other = provider('session-watch', { id: 'b1', text: '感觉是空的' }, 'persona-B')
    expect(other?.text).not.toContain('safety first')

    const samePersona = provider('session-watch', { id: 'a3', text: '感觉是空的' }, 'persona-A')
    expect(samePersona?.text).toContain('safety first')
  })

  it('audits the safety turns it took, and keeps the words of the user out of the audit', () => {
    installFakeStorage()
    const provider = createRelationalPolicyContextProvider()
    const observability = useContextObservabilityStore()

    provider('session-audit', { id: 'x1', text: '这周真的很崩溃' })
    provider('session-audit', { id: 'x2', text: '我撑不住了' })
    provider('session-audit', { id: 'x3', text: '感觉是空的' })

    const audits = observability.crisisAudits
    expect(audits.length).toBeGreaterThan(0)
    // Newest first, so the turn the run lifted is at the front.
    expect(audits[0]).toMatchObject({ level: 'crisis', escalated: true, resourcesOffered: true, categories: ['numbness'] })
    const dumped = JSON.stringify(audits)
    for (const text of ['这周真的很崩溃', '我撑不住了', '感觉是空的'])
      expect(dumped, text).not.toContain(text)
  })

  it('leaves no audit behind for an ordinary conversation', () => {
    installFakeStorage()
    const provider = createRelationalPolicyContextProvider()
    const observability = useContextObservabilityStore()

    provider('session-quiet', { id: 'q1', text: '今天有点累' })
    provider('session-quiet', { id: 'q2', text: '明天几点开会' })

    expect(observability.crisisAudits).toEqual([])
  })

  it('never lifts an ordinary conversation', () => {
    installFakeStorage()
    const provider = createRelationalPolicyContextProvider()
    for (const [index, text] of ['今天有点累', '明天几点开会', '我最近在学做饭', '晚安'].entries()) {
      const message = provider('session-calm', { id: `c${index}`, text })
      expect(message?.text, text).not.toContain('safety first')
    }
  })
})

describe('relational policy persistence', () => {
  it('restores depth after a reload', () => {
    installFakeStorage()
    installFakeClock()
    const before = createRelationalPolicyContextProvider()
    before('session-1', { id: 'a', text: '我害怕一个人待着' })
    advance()
    const deep = before('session-1', { id: 'b', text: '我其实很喜欢猫' })
    const depth = Number(/Depth: (\d) of 4/.exec(deep?.text ?? '')?.[1])
    expect(depth).toBeGreaterThan(1)

    const after = createRelationalPolicyContextProvider()
    const restored = after('session-1', { id: 'c', text: '今天天气不错' })

    expect(restored?.text).toContain(`Depth: ${depth} of 4`)
  })

  it('ignores corrupt stored state', () => {
    const store = installFakeStorage()
    store.set('castalia:relationship:session-1', '{"stage":99}')

    const provider = createRelationalPolicyContextProvider()
    const message = provider('session-1', { id: 'a', text: '今天天气不错' })

    expect(message?.text).toContain('Depth: 1 of 4')
  })

  it('shares depth across sessions of one persona', () => {
    installFakeStorage()
    installFakeClock()
    const before = createRelationalPolicyContextProvider()
    before('session-1', { id: 'a', text: '我害怕一个人待着' }, 'airi')
    advance()
    const deep = before('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'airi')
    const depth = Number(/Depth: (\d) of 4/.exec(deep?.text ?? '')?.[1])
    expect(depth).toBeGreaterThan(1)

    const otherSession = createRelationalPolicyContextProvider()

    expect(otherSession('session-2', { id: 'c', text: '今天天气不错' }, 'airi')?.text).toContain(`Depth: ${depth} of 4`)
    expect(otherSession('session-3', { id: 'd', text: '今天天气不错' }, 'another-persona')?.text).toContain('Depth: 1 of 4')
  })

  it('starts a new persona from depth 1 inside one session', () => {
    installFakeStorage()
    installFakeClock()
    const provider = createRelationalPolicyContextProvider()
    provider('session-1', { id: 'a', text: '我害怕一个人待着' }, 'persona-A')
    advance()
    const deep = provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-A')
    expect(Number(/Depth: (\d) of 4/.exec(deep?.text ?? '')?.[1])).toBeGreaterThan(1)

    const switched = provider('session-1', { id: 'c', text: '今天天气不错' }, 'persona-B')

    expect(switched?.text).toContain('Depth: 1 of 4')
  })

  it('starts a new persona from depth 1 when the message id repeats', () => {
    installFakeStorage()
    installFakeClock()
    const provider = createRelationalPolicyContextProvider()
    provider('session-1', { id: 'a', text: '我害怕一个人待着' }, 'persona-A')
    advance()
    const deep = provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-A')
    expect(Number(/Depth: (\d) of 4/.exec(deep?.text ?? '')?.[1])).toBeGreaterThan(1)

    const switched = provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-B')

    expect(switched?.text).toContain('Depth: 1 of 4')
    expect(switched?.text).not.toBe(deep?.text)
  })

  it('counts one signal per persona per user turn across a switch back', () => {
    installFakeStorage()
    installFakeClock()
    const provider = createRelationalPolicyContextProvider()
    const depthOf = (text?: string) => Number(/Depth: (\d) of 4/.exec(text ?? '')?.[1])

    provider('session-1', { id: 'a', text: '我害怕一个人待着' }, 'persona-A')
    advance()
    provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-A')
    provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-B')
    provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-A')
    advance()
    const afterSwitch = provider('session-1', { id: 'c', text: '我其实很喜欢猫' }, 'persona-A')

    // The same three turns without a switch. Persona-A must end where an
    // undisturbed persona ends, because the switch back re-sent an id it
    // already counted.
    provider('session-2', { id: 'a', text: '我害怕一个人待着' }, 'persona-C')
    advance()
    provider('session-2', { id: 'b', text: '我其实很喜欢猫' }, 'persona-C')
    advance()
    const control = provider('session-2', { id: 'c', text: '我其实很喜欢猫' }, 'persona-C')

    expect(depthOf(control?.text)).toBeGreaterThan(1)
    expect(depthOf(afterSwitch?.text)).toBe(depthOf(control?.text))
  })

  it('drops the oldest session once it tracks 64', () => {
    const store = installFakeStorage()
    const provider = createRelationalPolicyContextProvider()
    provider('session-0', { id: 'again', text: '今天天气不错' })
    store.delete('castalia:relationship:session-0')

    for (let index = 1; index <= 64; index++)
      provider(`session-${index}`, { id: `m${index}`, text: '今天天气不错' })

    provider('session-0', { id: 'again', text: '今天天气不错' })

    // A cached turn of the same message is reused without touching storage.
    // The write therefore proves the evicted session rebuilt from scratch.
    expect(store.has('castalia:relationship:session-0')).toBe(true)
  })
})
