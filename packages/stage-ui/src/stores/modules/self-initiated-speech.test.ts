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
  relieve: vi.fn(),
  mood: vi.fn(),
  lookAround: vi.fn(async () => 1),
  mind: {
    asleep: false,
    napping: false,
    interruptAllowed: true,
    interruptReason: undefined as string | undefined,
    interruptVerdictAt: undefined as number | undefined,
    // 一处裁决：`free` / `busy` / `away` / `unknown`。旧测试只改 `interruptAllowed`，
    // 这里让默认值等价于原来那句「没有裁决就算可以开口」。
    interruption: { level: 'free' as 'away' | 'busy' | 'free' | 'unknown', reason: 'interruptible' as string | undefined },
    // 开口那一刻只看这一眼之后的裁决；默认跟随同一个配置，个别用例单独覆盖。
    interruptionSince: vi.fn((_startedAt: number) => ({ level: 'free' as 'away' | 'busy' | 'free' | 'unknown', reason: 'interruptible' as string | undefined })),
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
    get interruption() {
      return mocks.mind.interruption
    },
    interruptionNow: () => mocks.mind.interruption,
    interruptionSince: mocks.mind.interruptionSince,
    innerContextLine: mocks.mind.innerContextLine,
    lookAround: mocks.lookAround,
    markSaidOutLoud: mocks.markSpoken,
    relieveAfterSpeaking: mocks.relieve,
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
    mocks.mind.interruption = { level: 'free', reason: 'interruptible' }
    mocks.mind.interruptionSince.mockReset()
    mocks.mind.interruptionSince.mockImplementation(() => mocks.mind.interruption)
    mocks.notify.mockClear()
    mocks.lookAround.mockClear()
    mocks.markSpoken.mockClear()
    mocks.relieve.mockClear()
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
    // 那一眼的耗时要落盘：20 秒预算够不够，面板上要有数可看。
    expect(store.diagnostics.lookMs).toBeTypeOf('number')
  })

  it('records a failed send as failed, not as spoken', async () => {
    // notify 返回 undefined 表示这一句没进聊天。面板若记成 `sent`，一次失败就永远看不见。
    const store = mountStore(election(true).runtime)
    store.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(store.diagnostics.lastReason).toBe('send-failed')
    expect(store.diagnostics.lastSpokeAt).toBeUndefined()
    // 没送出去就不付无聊：她还没说过话。
    expect(mocks.relieve).not.toHaveBeenCalled()
  })

  it('does not spend the pacing on a failed send, and retries after a cooldown', async () => {
    const store = mountStore(election(true).runtime)
    store.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(store.diagnostics.lastReason).toBe('send-failed')

    // 冷却期内不再尝试：失败不计节奏，但不能每秒重试。
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(mocks.notify).toHaveBeenCalledTimes(1)

    // 冷却结束后再来一次；这一回送到了。
    mocks.notify.mockResolvedValueOnce({ ok: true, text: '在。' })
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    expect(store.diagnostics.lastReason).toBe('sent')

    store.stop()
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
    // 说过一次就要把无聊付掉，否则下一跳又想开口、又抓一次屏。
    expect(mocks.relieve).toHaveBeenCalledTimes(1)
  })

  it('stays silent while the last verdict already says it is a bad moment', async () => {
    mocks.mind.interruptAllowed = false
    mocks.mind.interruptReason = 'fullscreen-game'
    mocks.mind.interruptVerdictAt = Date.now()
    mocks.mind.interruption = { level: 'busy', reason: 'fullscreen-game' }
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
      mocks.mind.interruption = { level: 'busy', reason: 'fullscreen-game' }
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

  it('holds the tongue when the owner is away, without paying for a capture', async () => {
    mocks.mind.interruption = { level: 'away', reason: 'screen-locked' }
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.lookAround).not.toHaveBeenCalled()
    expect(mocks.notify).not.toHaveBeenCalled()
  })

  it('still speaks when the screen is unknown, and records the busy question if the model asks it', async () => {
    // 看不见不等于不忙：这一句仍然可以发，但「你在忙吗」是感知本来能回答的问题，
    // 出现了就要在诊断里留下证据——它意味着上下文没压住模型。
    mocks.mind.interruption = { level: 'unknown', reason: 'no-screen-verdict' }
    mocks.notify.mockResolvedValueOnce({ ok: true, text: '你在忙吗？要不要我晚点再问。' })
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.notify).toHaveBeenCalledTimes(1)
    expect(store.diagnostics.askedBusyAt).toBeTypeOf('number')
    expect(store.diagnostics.lastReason).toBe('asked-busy')
  })

  it('asks the look-scoped verdict before it speaks, not the gate\'s older one', async () => {
    // 门（1s 一跳）读的是 mind 的当前裁决；真正开口时只认这一眼之后的那份。
    mocks.mind.interruptionSince.mockImplementation((startedAt: number) => {
      expect(typeof startedAt).toBe('number')
      expect(Date.now() - startedAt).toBeLessThanOrEqual(5_000)
      return { level: 'unknown', reason: 'no-screen-verdict' }
    })
    const store = mountStore(election(true).runtime)
    store.start()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(mocks.mind.interruptionSince).toHaveBeenCalledTimes(1)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
  })
})
