import type { Thought } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = {
  thoughts: [] as Thought[],
  lastSeenAt: undefined as number | undefined,
  append: vi.fn(async (thought: Thought) => { store.thoughts.push(thought) }),
  readAll: vi.fn(async () => [...store.thoughts]),
  readLastSeenAt: vi.fn(async () => store.lastSeenAt),
  saveLastSeenAt: vi.fn(async (at: number) => { store.lastSeenAt = at }),
  clear: vi.fn(async () => { store.thoughts = [] }),
}

vi.mock('../../database/repos/inner-thoughts.repo', () => ({ innerThoughtsRepo: store }))

const { useMindStore } = await import('./mind')

const calm = () => ({ fatigue: 0, boredom: 0, curiosity: 0, focus: 0 })

describe('mind store, end to end', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.thoughts = []
    store.lastSeenAt = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('opens with what it did while away', async () => {
    store.thoughts = [{ id: 'a', at: 1, text: 'archived two notes', visibility: 'private' }]
    store.lastSeenAt = Date.now() - 8 * 3_600_000

    const mind = useMindStore()
    mind.drives = { fatigue: 90, boredom: 0, curiosity: 0, focus: 0 }

    await mind.initialize()

    expect(mind.wokeUp).toBe(true)
    expect(mind.drives.fatigue).toBe(0)
    expect(mind.opening).toBe('archived two notes')
    mind.dispose()
  })

  it('says nothing when nothing happened', async () => {
    const mind = useMindStore()
    await mind.initialize()
    expect(mind.opening).toBeUndefined()
    mind.dispose()
  })

  it('writes a private thought on a tick, and keeps it on disk', async () => {
    const mind = useMindStore()
    await mind.initialize()

    mind.drives = { fatigue: 0, boredom: 60, curiosity: 0, focus: 0 }
    mind.observe('the build failed')

    // One tick with a roll under the lane chance. `Math.random` is the boundary.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.01)
    mind.tick(Date.now() + 45_000)
    random.mockRestore()

    expect(mind.stream.entries.length).toBeGreaterThan(0)
    expect(store.append).toHaveBeenCalled()
    mind.dispose()
  })

  it('hands a heavy chore off, then does it when asked again', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { fatigue: 95, boredom: 0, curiosity: 0, focus: 0 }

    const chore = `${Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? '\t' : '') + 'x'.repeat(150)).join('\n')}\n整理成表格`

    const first = mind.handoffFor(chore)
    expect(first?.line).toBeTruthy()
    expect(mind.delegations).toHaveLength(1)
    expect(mind.delegations[0].text).toBe(chore)

    const second = mind.handoffFor(chore)
    expect(second).toBeUndefined()

    mind.settleDelegation(mind.delegations[0].id)
    expect(mind.delegations).toHaveLength(0)
    mind.dispose()
  })

  it('never hands off a question', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { fatigue: 99, boredom: 0, curiosity: 0, focus: 0 }

    expect(mind.handoffFor('这个报错是什么原因？')).toBeUndefined()
    expect(mind.delegations).toHaveLength(0)
    mind.dispose()
  })

  it('shares a private thought only after the user pokes it', async () => {
    store.thoughts = [{ id: 'a', at: Date.now() - 120_000, text: 'wondering about the build', visibility: 'private' }]

    const mind = useMindStore()
    await mind.initialize()

    const poked = mind.poke()
    expect(poked?.text).toBe('wondering about the build')
    expect(mind.heldBack?.text).toBe('wondering about the build')
    mind.dispose()
  })

  it('counts each finished turn as effort', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { ...calm() }

    let fire: (() => Promise<void>) | undefined
    mind.attachTurnComplete((cb) => {
      fire = cb
      return () => {}
    })
    await fire?.()

    expect(mind.drives.fatigue).toBe(1)
    expect(mind.drives.focus).toBe(2)
    mind.dispose()
  })

  it('remembers when it closed', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.dispose()
    expect(store.saveLastSeenAt).toHaveBeenCalled()
  })
})
