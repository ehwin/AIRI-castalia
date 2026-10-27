import { afterEach, describe, expect, it } from 'vitest'

import { createRelationalPolicyContextProvider } from './context-providers/relational-policy'

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

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
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

describe('relational policy persistence', () => {
  it('restores depth after a reload', () => {
    installFakeStorage()
    const before = createRelationalPolicyContextProvider()
    before('session-1', { id: 'a', text: '我害怕一个人待着' })
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
    const before = createRelationalPolicyContextProvider()
    before('session-1', { id: 'a', text: '我害怕一个人待着' }, 'airi')
    const deep = before('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'airi')
    const depth = Number(/Depth: (\d) of 4/.exec(deep?.text ?? '')?.[1])

    const otherSession = createRelationalPolicyContextProvider()

    expect(otherSession('session-2', { id: 'c', text: '今天天气不错' }, 'airi')?.text).toContain(`Depth: ${depth} of 4`)
    expect(otherSession('session-3', { id: 'd', text: '今天天气不错' }, 'another-persona')?.text).toContain('Depth: 1 of 4')
  })

  it('starts a new persona from depth 1 inside one session', () => {
    installFakeStorage()
    const provider = createRelationalPolicyContextProvider()
    provider('session-1', { id: 'a', text: '我害怕一个人待着' }, 'persona-A')
    const deep = provider('session-1', { id: 'b', text: '我其实很喜欢猫' }, 'persona-A')
    expect(Number(/Depth: (\d) of 4/.exec(deep?.text ?? '')?.[1])).toBeGreaterThan(1)

    const switched = provider('session-1', { id: 'c', text: '今天天气不错' }, 'persona-B')

    expect(switched?.text).toContain('Depth: 1 of 4')
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
