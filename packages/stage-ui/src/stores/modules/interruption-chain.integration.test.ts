import type { SensePort, Thought } from '@proj-airi/core-agent'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { injectKeyPiniaSynced } from '../../libs/pinia/synced-context'

/**
 * 全链路：感知 → 裁决 → 门 → 提示词 → 发出去的那一句。
 *
 * 这里不 mock `mind`，也不用真聊天：只有聊天/模型那一层是假的，其余都是真 store。
 * 它验的是那条用户能看见的链：桌面上发生什么，最终决定她收不开口、以及她读到的是
 * 哪一版结论。
 */

const repo = {
  thoughts: [] as Thought[],
  lastSeenAt: undefined as number | undefined,
  append: vi.fn(async (thought: Thought) => { repo.thoughts.push(thought) }),
  readAll: vi.fn(async () => [...repo.thoughts]),
  readLastSeenAt: vi.fn(async () => repo.lastSeenAt),
  saveLastSeenAt: vi.fn(async (at: number) => { repo.lastSeenAt = at }),
  clear: vi.fn(async () => { repo.thoughts = [] }),
}

vi.mock('../../database/repos/inner-thoughts.repo', () => ({ innerThoughtsRepo: repo }))

const sent: { source: string, text: string }[] = []
const mood = vi.fn()

vi.mock('@proj-airi/castalia-plugin', () => ({
  useCastaliaPluginStore: () => ({
    enabled: true,
    snapshotFor: () => ({ energy: 80, currentDesire: '', vad: { arousal: 0 } }),
    recordMood: mood,
  }),
}))
vi.mock('../chat', () => ({
  useChatStore: () => ({
    sending: false,
    notifyConversation: async (_sessionId: string, notice: { source: string, text: string }) => {
      sent.push(notice)
      return { ok: true as const, text: '好。' }
    },
  }),
}))
vi.mock('../chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: 'sid-1',
    sessionMetas: { 'sid-1': { characterId: 'card-1' } },
    getSessionMessagesIfLoaded: () => [],
  }),
}))
vi.mock('../chat/context-providers/relational-policy', () => ({ readStoredRelationship: () => undefined }))
vi.mock('../memory', () => ({ useMemoryStore: () => ({ enabled: false, resolvePersona: (id: string) => id }) }))

const { useMindStore } = await import('./mind')
const { useSelfInitiatedSpeechStore } = await import('./self-initiated-speech')

/** 只有主席窗口能开口，这里直接给它。 */
function leaderRuntime(): SyncedPiniaRuntime {
  return {
    isLeader: () => true,
    onLeadershipChange: () => () => {},
  } as unknown as SyncedPiniaRuntime
}

function mountAll(): <T>(store: () => T) => T {
  const app = createApp({ render: () => null })
  const pinia = createPinia()
  app.use(pinia)
  app.provide(injectKeyPiniaSynced, leaderRuntime())
  setActivePinia(pinia)
  return <T>(store: () => T) => app.runWithContext(store)
}

function screenSense(look: SensePort['look']): SensePort {
  return { look }
}

describe('interruption chain, sense to utterance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T15:00:00+08:00'))
    vi.spyOn(Math, 'random').mockReturnValue(0)
    repo.thoughts = []
    sent.length = 0
    mood.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays silent while the screen says the owner is mid-task', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: 'IDE 里一个没提交的文件，光标停在函数中间', at: Date.now(), interruptible: false, reason: 'coding' },
    ]))
    await mind.lookAround({ force: true })
    expect(mind.interruption.level).toBe('busy')

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mind.senseAttached).toBe(true)
    expect(sent).toHaveLength(0)
    expect(speech.lastGateReason).toMatch(/^screen:/)
    mind.dispose()
    speech.stop()
  })

  it('speaks on a free screen, and the line she reads says not to ask', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: '一个浏览器窗口，页面停在新闻首页', at: Date.now(), interruptible: true, reason: 'browsing' },
    ]))

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    // 门读的是 mind 的当前裁决；先让它看一眼（真实路径里由 5 分钟扫视或上一轮对话写入）。
    await mind.lookAround({ force: true })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.source).toBe('self-initiated-speech')
    // `chat.ts` 每轮把这一行塞进 system context，所以它必须自己说得清。
    expect(mind.interruptionLine()).toContain('看起来可以说话')
    // 她读到的是裁决本身，不是一段画面描述——所以没有「你在忙吗」的余地。
    expect(sent[0]!.text).toContain('看起来可以说话')
    expect(sent[0]!.text).toContain('别问他在不在忙')
    expect(sent[0]!.text).toContain('浏览器')
    mind.dispose()
    speech.stop()
  })

  it('still speaks when vision only returned a description, without claiming the owner is free', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      // 视觉降级到 `screen:interpret`：有描述、没有裁决。
      { kind: 'screen' as const, text: '**Active App:** a browser window', at: Date.now() },
    ]))

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    await mind.lookAround({ force: true })
    expect(mind.interruption.level).toBe('unknown')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('你看不到屏幕')
    expect(sent[0]!.text).not.toContain('看起来可以说话')
    mind.dispose()
    speech.stop()
  })

  it('holds the loop for five minutes instead of asking again every second', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: 'IDE 里一个没提交的文件', at: Date.now(), interruptible: false, reason: 'coding' },
    ]))
    await mind.lookAround({ force: true })

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(0)
    expect(speech.diagnostics.lastReason).toMatch(/^screen:/)

    // 两分钟里她不再重算一遍、也不再落盘：一秒一跳的同一理由只算一次事件。
    const episodes = speech.gatedCount
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(speech.diagnostics.lastReason).toBe('screen-hold')
    expect(speech.gatedCount).toBe(episodes)

    // 五分钟后再看，桌面已经空下来：这一眼之后她可以说话。
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: '一个空桌面', at: Date.now(), interruptible: true, reason: 'idle-desktop' },
    ]))
    await mind.lookAround({ force: true })
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(sent).toHaveLength(1)

    mind.dispose()
    speech.stop()
  })

  it('re-reads the lock state before each look, so a screen locked a moment ago is not free', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense({
      look: async () => [{ kind: 'screen' as const, text: '一张壁纸', at: Date.now(), interruptible: true }],
      presence: async () => ({ state: 'locked' as const, idleSeconds: 5, at: Date.now() }),
    })

    // 没有经过 tick：只看一眼也必须先读到「锁屏」，否则视觉会对着壁纸说可以打扰。
    await mind.lookAround({ force: true })
    expect(mind.interruptionNow().level).toBe('away')
    mind.dispose()
  })

  it('ends the five-minute hold as soon as a newer look says the screen is free', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: 'IDE 里一个没提交的文件', at: Date.now(), interruptible: false, reason: 'coding' },
    ]))
    await mind.lookAround({ force: true })

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(0)

    // 定时扫视（或别处的一次 decide 看一眼）发现桌面空了：没理由再按五分钟前的结论闭嘴。
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: '一个空桌面', at: Date.now(), interruptible: true, reason: 'idle-desktop' },
    ]))
    await mind.lookAround({ force: true })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(1)

    mind.dispose()
    speech.stop()
  })

  it('does not let a hung presence reading hold the look', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense({
      look: async () => [{ kind: 'screen' as const, text: '一个空桌面', at: Date.now(), interruptible: true }],
      // 主进程不回话：look 不能被这一路拖住，否则她永远开不了口。
      presence: () => new Promise(() => {}),
    })

    const pending = mind.lookAround({ force: true })
    await vi.advanceTimersByTimeAsync(2_100)
    await pending

    expect(mind.interruptionNow().level).toBe('free')
    mind.dispose()
  })

  it('measures the verdict on the real clock, not on the 45-second tick', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: '一个空桌面', at: Date.now(), interruptible: true },
    ]))
    mind.tick(Date.now())
    await mind.lookAround({ force: true })
    expect(mind.interruptionLine()).toContain('看起来可以说话')

    // 20 分钟没有 tick：那条 free 已经过期。按 tick 时钟算，它还会被当作「此刻」。
    vi.setSystemTime(new Date(Date.now() + 20 * 60_000))
    expect(mind.interruptionLine()).toContain('你看不到屏幕')
    mind.dispose()
  })

  it('a reset lifts the screen hold instead of leaving the new session muted', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense(screenSense(async () => [
      { kind: 'screen' as const, text: 'IDE 里一个没提交的文件', at: Date.now(), interruptible: false, reason: 'coding' },
    ]))
    await mind.lookAround({ force: true })

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(speech.gatedCount).toBe(1)

    speech.resetOutbound()
    // 下一次判定仍然被同一块忙屏挡住：说明冷却与节流都被重置了，不是被旧状态按住。
    await vi.advanceTimersByTimeAsync(1_000)
    expect(speech.gatedCount).toBe(1)

    mind.dispose()
    speech.stop()
  })

  it('treats a locked screen as away before the vision answer counts', async () => {
    const use = mountAll()
    const mind = use(useMindStore)
    await mind.initialize()
    mind.attachSense({
      look: async () => [{
        kind: 'screen' as const,
        text: '锁屏壁纸',
        at: Date.now(),
        interruptible: true,
      }],
      presence: async () => ({ state: 'locked' as const, idleSeconds: 30, at: Date.now() }),
    })
    // presence 由心智 tick 读进来。
    mind.tick(Date.now())
    await Promise.resolve()
    await mind.lookAround({ force: true })

    expect(mind.interruption.level).toBe('away')
    expect(mind.interruption.reason).toBe('screen-locked')

    const speech = use(useSelfInitiatedSpeechStore)
    speech.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(0)
    mind.dispose()
    speech.stop()
  })
})
