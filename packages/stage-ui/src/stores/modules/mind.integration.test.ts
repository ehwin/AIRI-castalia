import type { Thought } from '@proj-airi/core-agent'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('moves a thought out of the diary when she repeats it aloud', async () => {
    // ROOT CAUSE: nothing ever set `visibility: 'shared'`, so the diary's "said out loud"
    // column could only read zero. The producer is the delivered line itself.
    store.thoughts = [{ id: 'said-1', at: 1, text: 'noticed: 主人今天看起来很累', visibility: 'private', topic: 'self-cycle' }]
    const mind = useMindStore()
    await mind.initialize()

    const marked = mind.markSaidOutLoud('主人今天看起来很累，那就早点睡吧。')

    expect(marked?.id).toBe('said-1')
    expect(mind.stream.entries.find(entry => entry.id === 'said-1')?.visibility).toBe('shared')
    expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ id: 'said-1', visibility: 'shared' }))
    mind.dispose()
  })

  it('leaves a thought private when the line does not repeat it', async () => {
    store.thoughts = [{ id: 'said-2', at: 1, text: 'noticed: 主人今天看起来很累', visibility: 'private', topic: 'self-cycle' }]
    const mind = useMindStore()
    await mind.initialize()

    expect(mind.markSaidOutLoud('我去把窗户关上。')).toBeUndefined()
    expect(mind.stream.entries.find(entry => entry.id === 'said-2')?.visibility).toBe('private')
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
    mind.drives = { ...calm(), boredom: 40 }

    let fire: (() => Promise<void>) | undefined
    mind.attachTurnComplete((cb) => {
      fire = cb
      return () => {}
    })
    await fire?.()

    expect(mind.drives.fatigue).toBe(1)
    expect(mind.drives.focus).toBe(2)
    // An exchange pays boredom down; working next to her would not.
    expect(mind.drives.boredom).toBe(28)
    mind.dispose()
  })

  it('remembers when it closed', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.dispose()
    expect(store.saveLastSeenAt).toHaveBeenCalled()
  })

  it('is blind until a sense is attached', async () => {
    const mind = useMindStore()
    await mind.initialize()

    expect(mind.senseAttached).toBe(false)
    await expect(mind.lookAround()).resolves.toBe(0)
    mind.dispose()
  })

  it('takes what a sense sees as new once, not on every look', async () => {
    const mind = useMindStore()
    await mind.initialize()

    const look = vi.fn(async () => [
      { kind: 'screen' as const, text: 'a failing test in the editor', at: Date.now() },
      { kind: 'camera' as const, text: 'the owner is at the desk', at: Date.now() },
    ])

    mind.attachSense({ look })
    expect(mind.senseAttached).toBe(true)

    await expect(mind.lookAround()).resolves.toBe(2)
    // The same desktop is not new twice. `force` bypasses the one-minute glance guard so this
    // still exercises the digest, not the guard.
    await expect(mind.lookAround({ force: true })).resolves.toBe(0)
    mind.dispose()
  })

  it('does not capture twice within a minute unless the caller forces it', async () => {
    const mind = useMindStore()
    await mind.initialize()
    const look = vi.fn(async () => [{ kind: 'screen' as const, text: `窗口 ${Date.now()}`, at: Date.now() }])
    mind.attachSense({ look })

    await mind.lookAround()
    await mind.lookAround()
    expect(look).toHaveBeenCalledTimes(1)

    // 开口前那一眼不能被节流挡住，否则她会拿几分钟前的画面装作刚看过。
    await mind.lookAround({ force: true })
    expect(look).toHaveBeenCalledTimes(2)
    mind.dispose()
  })

  it('survives a sense that throws', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.attachSense({
      look: async () => {
        throw new Error('permission denied')
      },
    })

    await expect(mind.lookAround()).resolves.toBe(0)
    mind.dispose()
  })

  it('does not turn a description without a verdict into permission', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.attachSense({ look: async () => [{ kind: 'screen' as const, text: '一个浏览器窗口，停在一篇文章上', at: Date.now() }] })

    await mind.lookAround({ force: true })

    // 关键词没命中 ≠ 可以打扰。没有裁决就是不知道，和「看不见」同一个结论。
    expect(mind.interruption.level).toBe('unknown')
    mind.dispose()
  })

  it('lets the vision verdict win over the keywords', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.attachSense({
      look: async () => [{ kind: 'screen' as const, text: '终端在编译，他只是在等结果', at: Date.now(), interruptible: true, reason: 'waiting' }],
    })

    await mind.lookAround({ force: true })

    // 关键词会说「在编译 = 忙」；裁决说可以。忙闲以视觉裁决为准，关键词不是判据。
    expect(mind.interruption.level).toBe('free')
    mind.dispose()
  })

  it('will not claim the owner is free from a look older than the utterance', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T10:00:00+08:00'))
    const mind = useMindStore()
    await mind.initialize()
    let observation: { kind: 'screen', text: string, at: number, interruptible?: boolean } = {
      kind: 'screen',
      text: '一个浏览器窗口',
      at: Date.now(),
      interruptible: true,
    }
    mind.attachSense({ look: async () => [observation] })
    await mind.lookAround({ force: true })
    expect(mind.interruption.level).toBe('free')

    // 五分钟后想开口；这一眼只回了描述（超时/解析失败），没有新裁决。
    vi.setSystemTime(new Date('2026-11-11T10:05:00+08:00'))
    observation = { kind: 'screen', text: '一个浏览器窗口', at: Date.now() }
    const startedAt = Date.now()
    await mind.lookAround({ force: true })

    // 十五分钟有效期内，普通回合还能用这条旧裁决；
    // 但开口那一刻只认这一眼——旧的不算「刚看见他不忙」。
    expect(mind.interruption.level).toBe('free')
    expect(mind.interruptionSince(startedAt).level).toBe('unknown')
    mind.dispose()
  })
})

describe('sleep, in the same loop', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.thoughts = []
    store.lastSeenAt = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('lies down when the night tick asks, and the maintenance report sets the rate', async () => {
    const mind = useMindStore()
    await mind.initialize()
    const nights: number[] = []
    mind.attachSleep(async () => {
      nights.push(Date.now())
      return { reflectOk: true, consolidateOk: true, digestOk: true }
    })

    let fire: (() => Promise<void>) | undefined
    mind.attachTurnComplete((cb) => {
      fire = cb
      return () => {}
    })
    await fire?.()

    let now = Date.now()
    mind.drives = { fatigue: 85, boredom: 0, curiosity: 0, focus: 0 }
    // A night waits for a quiet room; ten minutes after the last turn is enough.
    mind.tick(now + 11 * 60_000)
    now += 11 * 60_000
    await Promise.resolve()
    await Promise.resolve()

    expect(mind.asleep).toBe(true)
    expect(nights).toHaveLength(1)
    expect(mind.lastSleepQuality).toBeCloseTo(1, 6)

    // The first tick or two run at the provisional 0.5 rate until the report lands,
    // so five and a half hours lands just above the wake threshold, not exactly on it.
    for (let i = 0; i < 440; i++) {
      now += 45_000
      mind.tick(now)
    }

    expect(mind.asleep).toBe(false)
    expect(mind.sleepCount).toBe(1)
    expect(mind.drives.fatigue).toBeLessThanOrEqual(22)
    mind.dispose()
  })

  it('wakes with a fresh attention span, not the boredom she lay down with', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.attachSleep(async () => ({ reflectOk: true, consolidateOk: true, digestOk: true }))
    let fire: (() => Promise<void>) | undefined
    mind.attachTurnComplete((cb) => {
      fire = cb
      return () => {}
    })
    await fire?.()

    let now = Date.now()
    mind.drives = { fatigue: 85, boredom: 60, curiosity: 0, focus: 0 }
    mind.tick(now + 11 * 60_000)
    now += 11 * 60_000
    await Promise.resolve()
    await Promise.resolve()
    expect(mind.asleep).toBe(true)
    const lyingDown = mind.drives.boredom

    let woke = false
    for (let i = 0; i < 440 && !woke; i++) {
      now += 45_000
      mind.tick(now)
      woke = !mind.asleep
    }
    expect(woke).toBe(true)
    // 睡了一夜还带着躺下时那格无聊，睁眼第一跳就会「无聊到想说话」。
    expect(mind.drives.boredom).toBeLessThanOrEqual(lyingDown - 24)
    mind.dispose()
  })

  it('pays boredom down when a line actually goes out', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { fatigue: 10, boredom: 80, curiosity: 40, focus: 0 }

    mind.relieveAfterSpeaking()

    expect(mind.drives.boredom).toBe(35)
    expect(mind.drives.curiosity).toBe(30)
    mind.dispose()
  })

  describe('noise', () => {
    async function walk(withNoise: boolean, seed = 7) {
      setActivePinia(createPinia())
      const mind = useMindStore()
      await mind.initialize()
      if (withNoise)
        mind.attachNoise({ seed })
      let now = Date.now()
      mind.drives = { fatigue: 10, boredom: 50, curiosity: 0, focus: 0 }
      for (let i = 0; i < 40; i++) {
        now += 45_000
        mind.tick(now)
      }
      const result = {
        drives: { ...mind.drives },
        wobble: { boredom: mind.wobble.boredom, curiosity: mind.wobble.curiosity },
        offset: mind.todayOffset,
      }
      mind.dispose()
      return result
    }

    it('stays exactly still until the host attaches a source', async () => {
      const plain = await walk(false)

      expect(plain.wobble).toEqual({ boredom: 0, curiosity: 0 })
      expect(plain.offset).toBe(0)
    })

    it('drifts her mood without touching what is recorded', async () => {
      const plain = await walk(false)
      const noisy = await walk(true)

      expect(Math.abs(noisy.wobble.boredom)).toBeGreaterThan(0)
      expect(Math.abs(noisy.wobble.boredom)).toBeLessThan(15)
      expect(Math.abs(noisy.offset)).toBeLessThanOrEqual(5)
      // 噪声只进判定：同样的环境走完同样多的 tick，落盘的驱力一模一样。
      expect(noisy.drives).toEqual(plain.drives)
    })

    it('replays one day from one seed and diverges on another', async () => {
      const first = await walk(true, 7)
      const again = await walk(true, 7)
      const other = await walk(true, 8)

      expect(again.wobble).toEqual(first.wobble)
      expect(other.wobble).not.toEqual(first.wobble)
    })
  })

  it('runs one maintenance call per bout', async () => {
    const mind = useMindStore()
    await mind.initialize()
    const nights = vi.fn(async () => ({ reflectOk: true }))
    mind.attachSleep(nights)

    const first = await mind.sleepNow(1_000)
    const second = await mind.sleepNow(1_000)

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(nights).toHaveBeenCalledTimes(1)
    mind.dispose()
  })

  it('treats a missing report as a lighter sleep, not insomnia', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.attachSleep(async () => undefined)
    await mind.sleepNow(1_000)
    expect(mind.asleep).toBe(true)
    expect(mind.lastSleepQuality).toBe(0.5)
    mind.dispose()
  })

  it('keeps a night open across a reload instead of refilling the battery', async () => {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    })

    const first = useMindStore()
    await first.initialize()
    first.attachSleep(async () => ({ reflectOk: true, consolidateOk: true, digestOk: true }))
    first.drives = { fatigue: 85, boredom: 0, curiosity: 0, focus: 0 }
    const start = Date.now() - 2 * 3_600_000
    await first.sleepNow(start)
    first.tick(start + 2 * 3_600_000)
    const beforeReload = first.drives.fatigue
    first.dispose()

    // A fresh store, as after a reload: the same bout continues.
    setActivePinia(createPinia())
    const second = useMindStore()
    await second.initialize()

    expect(second.asleep).toBe(true)
    expect(second.drives.fatigue).toBeLessThanOrEqual(beforeReload)
    expect(second.drives.fatigue).toBeGreaterThan(0)
    second.dispose()
    vi.unstubAllGlobals()
  })
})

describe('restart and window ownership', () => {
  function stubStorage() {
    const memory = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
    })
    return memory
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    store.thoughts = []
    store.lastSeenAt = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the saved drives when she restarts awake', async () => {
    const memory = stubStorage()
    memory.set('castalia/mind-state/default', JSON.stringify({
      drives: { fatigue: 70, boredom: 40, curiosity: 30, focus: 50 },
      at: Date.now() - 60_000,
    }))

    const mind = useMindStore()
    await mind.initialize()

    // One minute of rest at 12.5/h, not a full battery: the old order computed
    // `planReturn` from the defaults and then copied that over the snapshot.
    expect(mind.drives.fatigue).toBeCloseTo(69.7917, 3)
    // 一分钟的离开不是无聊的休息：注意力两轴按各自的时钟轻微松弛，值仍在原处。
    expect(mind.drives.boredom).toBeCloseTo(40, 0)
    expect(mind.drives.curiosity).toBeGreaterThan(25)
    mind.dispose()
  })

  it('migrates the legacy unscoped snapshot to the character key', async () => {
    const memory = stubStorage()
    memory.set('castalia/mind-state', JSON.stringify({
      drives: { fatigue: 42, boredom: 10, curiosity: 0, focus: 0 },
      at: Date.now(),
    }))

    const mind = useMindStore()
    await mind.initialize('alice')

    expect(mind.drives.fatigue).toBeCloseTo(42, 3)
    expect(JSON.parse(memory.get('castalia/mind-state/alice')!).drives.fatigue).toBeCloseTo(42, 3)
    mind.dispose()
  })

  it('lets only one window advance the mind, then hands over', async () => {
    stubStorage()
    const first = useMindStore()
    await first.initialize()
    expect(first.isOwner).toBe(true)

    setActivePinia(createPinia())
    const second = useMindStore()
    await second.initialize()
    expect(second.isOwner).toBe(false)

    const before = second.drives.fatigue
    second.tick(Date.now() + 60_000)
    expect(second.drives.fatigue).toBe(before)

    // The first window stopped renewing its lease; after the TTL the second
    // takes over and settles the gap from the snapshot.
    second.tick(Date.now() + 5 * 60_000)
    expect(second.isOwner).toBe(true)
    expect(second.drives.fatigue).toBeGreaterThan(before)
    first.dispose()
    second.dispose()
  })
})

describe('a nap, between boredom and the night', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.thoughts = []
    store.lastSeenAt = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('starts after a long quiet stretch, ends on its cap, and runs no maintenance', async () => {
    const mind = useMindStore()
    await mind.initialize()
    const nights = vi.fn(async () => ({ reflectOk: true }))
    mind.attachSleep(nights)

    let fire: (() => Promise<void>) | undefined
    mind.attachTurnComplete((cb) => {
      fire = cb
      return () => {}
    })
    await fire?.()

    const t0 = Date.now()
    mind.drives = { fatigue: 40, boredom: 80, curiosity: 0, focus: 0 }
    mind.tick(t0 + 46 * 60_000)
    expect(mind.napping).toBe(true)
    // A nap is free: the expensive consolidation belongs to the night.
    expect(nights).not.toHaveBeenCalled()

    let now = t0 + 46 * 60_000
    for (let i = 0; i < 50; i++) {
      now += 45_000
      mind.tick(now)
    }

    expect(mind.napping).toBe(false)
    expect(mind.napCount).toBe(1)
    expect(mind.drives.fatigue).toBeLessThan(40)
    expect(mind.drives.fatigue).toBeGreaterThan(20)
    mind.dispose()
  })

  it('does not nap while the owner is around', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { fatigue: 40, boredom: 90, curiosity: 0, focus: 0 }

    mind.tick(Date.now() + 45_000)

    expect(mind.napping).toBe(false)
    mind.dispose()
  })

  it('a thought that lands counts as engagement', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { ...calm(), boredom: 40, curiosity: 70 }
    mind.attachThink(async () => '窗外有人在搬家，纸箱堆到人行道上。')

    const thought = await mind.thinkNow(Date.now())
    expect(thought).toBe(true)
    expect(mind.drives.boredom).toBe(32)
    mind.dispose()
  })

  it('a turn ends a nap', async () => {
    const mind = useMindStore()
    await mind.initialize()
    let fire: (() => Promise<void>) | undefined
    mind.attachTurnComplete((cb) => {
      fire = cb
      return () => {}
    })

    mind.drives = { fatigue: 40, boredom: 90, curiosity: 0, focus: 0 }
    expect(mind.napNow(Date.now())).toBe(true)
    expect(mind.napping).toBe(true)

    await fire?.()

    expect(mind.napping).toBe(false)
    expect(mind.napCount).toBe(1)
    mind.dispose()
  })
})

describe('how often the state reaches the model', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    store.thoughts = []
    store.lastSeenAt = undefined
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('sticks to a changed state for three sends, then goes quiet', async () => {
    const mind = useMindStore()
    await mind.initialize()

    mind.drives = { fatigue: 80, boredom: 0, curiosity: 0, focus: 0 } // very tired
    // Sticky: rides along for three sends, then goes quiet until it changes.
    expect(mind.stateLineForSend()).toBe('very tired')
    expect(mind.stateLineForSend()).toBe('very tired')
    expect(mind.stateLineForSend()).toBe('very tired')
    expect(mind.stateLineForSend()).toBe('')
    expect(mind.stateLineForSend()).toBe('')

    mind.dispose()
  })

  it('sends nothing when there is nothing to say', async () => {
    const mind = useMindStore()
    await mind.initialize()
    mind.drives = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }
    expect(mind.stateLineForSend()).toBe('')
    mind.dispose()
  })

  it('sends a new state even inside the wait', async () => {
    const mind = useMindStore()
    await mind.initialize()

    mind.drives = { fatigue: 80, boredom: 0, curiosity: 0, focus: 0 }
    expect(mind.stateLineForSend()).toBe('very tired')

    mind.drives = { fatigue: 50, boredom: 0, curiosity: 0, focus: 0 }
    expect(mind.stateLineForSend()).toBe('tired')

    mind.dispose()
  })
})
