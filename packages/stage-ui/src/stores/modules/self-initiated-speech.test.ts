import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { injectKeyPiniaSynced } from '../../libs/pinia/synced-context'
import { useSelfInitiatedSpeechStore } from './self-initiated-speech'

/**
 * What a window may do on its own, and what she must look at before she does it.
 *
 * Every renderer mounts this store: the stage window, the floating chat, the settings window, and the
 * inlay overlay. Each one used to run its own ticker with its own copy of the outbound gate, so a fresh
 * pace opened all of them at the same instant and she answered three times in a row.
 *
 * The screen is read again at the moment she speaks, not only at the mind's five-minute glance: a
 * verdict from minutes ago says whether the owner was interruptible then.
 */

const mocks = vi.hoisted(() => ({
  // The store reads the delivered reply, so the mock must be able to return one (or nothing when a
  // send is gated).
  notify: vi.fn<(sessionId: string, notice: { source: string, text: string }) => Promise<{ ok: boolean, text: string } | undefined>>(async () => undefined),
  markSpoken: vi.fn(),
  mood: vi.fn(),
  lookAround: vi.fn(async () => 1),
  mind: {
    asleep: false,
    napping: false,
    interruptAllowed: true,
    interruptReason: undefined as string | undefined,
    interruptVerdictAt: undefined as number | undefined,
    innerContextLine: (): string => '你此刻看到：终端里在编译',
  },
  session: {
    activeSessionId: 'sid-1' as string | undefined,
    sessionMetas: { 'sid-1': { characterId: 'card-1' } } as Record<string, { characterId: string }>,
    getSessionMessagesIfLoaded: (): unknown[] => [],
  },
}))

vi.mock('@proj-airi/castalia-plugin', () => ({
  useCastaliaPluginStore: () => ({
    enabled: true,
    snapshotFor: () => ({ energy: 80, currentDesire: '', vad: { arousal: 0 } }),
    recordMood: mocks.mood,
  }),
}))
vi.mock('../chat', () => ({
  useChatStore: () => ({ sending: false, notifyConversation: mocks.notify }),
}))
vi.mock('../chat/session-store', () => ({
  useChatSessionStore: () => ({
    get activeSessionId() {
      return mocks.session.activeSessionId
    },
    sessionMetas: mocks.session.sessionMetas,
    getSessionMessagesIfLoaded: mocks.session.getSessionMessagesIfLoaded,
  }),
}))
vi.mock('../chat/context-providers/relational-policy', () => ({
  readStoredRelationship: () => undefined,
}))
vi.mock('../memory', () => ({
  useMemoryStore: () => ({ enabled: false, resolvePersona: (cardId: string) => cardId }),
}))
vi.mock('./mind', () => ({
  useMindStore: () => ({
    get asleep() {
      return mocks.mind.asleep
    },
    get napping() {
      return mocks.mind.napping
    },
    get interruptAllowed() {
      return mocks.mind.interruptAllowed
    },
    get interruptVerdictAt() {
      return mocks.mind.interruptVerdictAt
    },
    get interruptReason() {
      return mocks.mind.interruptReason
    },
    innerContextLine: mocks.mind.innerContextLine,
    lookAround: mocks.lookAround,
    markSaidOutLoud: mocks.markSpoken,
  }),
}))

interface ElectionControl {
  runtime: SyncedPiniaRuntime
  promote: (isLeader: boolean) => void
  listenerCount: () => number
}

/** An election the test drives by hand, with the runtime shape the store is injected with. */
function election(isLeader: boolean): ElectionControl {
  let leader = isLeader
  const callbacks: ((isLeader: boolean) => void)[] = []
  const runtime = {
    isLeader: () => leader,
    onLeadershipChange: (callback: (isLeader: boolean) => void) => {
      callbacks.push(callback)
      return () => {
        const index = callbacks.indexOf(callback)
        if (index >= 0)
          callbacks.splice(index, 1)
      }
    },
  } as unknown as SyncedPiniaRuntime

  return {
    runtime,
    listenerCount: () => callbacks.length,
    promote(next: boolean) {
      leader = next
      for (const callback of [...callbacks])
        callback(next)
    },
  }
}

function mountStore(runtime: SyncedPiniaRuntime) {
  const app = createApp({ render: () => null })
  app.use(createPinia())
  app.provide(injectKeyPiniaSynced, runtime)
  setActivePinia(app.config.globalProperties.$pinia as never)
  return app.runWithContext(() => useSelfInitiatedSpeechStore())
}

describe('self-initiated speech store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Three in the afternoon: the outbound gate keeps quiet hours from 23 to 7, and a test that runs
    // at night would be refused before it ever reached the tick.
    vi.setSystemTime(new Date('2026-11-03T15:00:00+08:00'))
    // The hybrid policy rolls on the tick. Zero wins the roll, so a prepared tick always speaks.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    mocks.mind.interruptAllowed = true
    mocks.mind.interruptReason = undefined
    mocks.mind.interruptVerdictAt = undefined
    mocks.notify.mockClear()
    mocks.lookAround.mockClear()
    mocks.markSpoken.mockClear()
    mocks.mood.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps the ticker closed in a window that holds no election', () => {
    const control = election(false)
    const store = mountStore(control.runtime)

    store.start()

    expect(store.running).toBe(false)
    expect(control.listenerCount()).toBe(1)
  })

  it('opens the ticker in the leader window', () => {
    const store = mountStore(election(true).runtime)

    store.start()

    expect(store.running).toBe(true)
    store.stop()
    expect(store.running).toBe(false)
  })

  it('follows the election when it moves to another window', () => {
    const control = election(false)
    const store = mountStore(control.runtime)

    store.start()
    control.promote(true)
    expect(store.running).toBe(true)

    control.promote(false)
    expect(store.running).toBe(false)

    store.stop()
    expect(control.listenerCount()).toBe(0)
  })

  it('reads the screen again before the word goes out', async () => {
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.lookAround).toHaveBeenCalledWith({ force: true })
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(mocks.notify.mock.calls[0][1].text).toContain('你此刻看到')
  })

  it('records one mood when the line actually reaches the chat', async () => {
    // A delivered line is an event, not only a log entry: the shared video's answer lands the same
    // way (one mood entry), and this is the speech half of that pattern.
    mocks.notify.mockResolvedValueOnce({ ok: true, text: '主人今天看起来很累，那就早点睡吧。' })
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.markSpoken).toHaveBeenCalledWith('主人今天看起来很累，那就早点睡吧。')
    expect(mocks.mood).toHaveBeenCalledWith(1, '我主动跟主人开口了', 'card-1')
  })

  it('stays silent while the last verdict already says it is a bad moment', async () => {
    mocks.mind.interruptAllowed = false
    mocks.mind.interruptReason = 'fullscreen-game'
    mocks.mind.interruptVerdictAt = Date.now()
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.lookAround).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('cancels a send the fresh look turns down, and holds the next attempts', async () => {
    // The gate read a stale "yes"; the look taken at send time says otherwise.
    mocks.lookAround.mockImplementationOnce(async () => {
      mocks.mind.interruptAllowed = false
      mocks.mind.interruptReason = 'fullscreen-game'
      mocks.mind.interruptVerdictAt = Date.now()
      return 1
    })
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.lookAround).toHaveBeenCalledWith({ force: true })
    expect(mocks.notify).not.toHaveBeenCalled()

    // A refusal costs one look, not one per tick: the next minute stays silent without a capture.
    mocks.lookAround.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.lookAround).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
