import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { asksIfBusy } from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { readScoped, writeScoped } from '../../libs/persona-scope'
import { usePiniaSynced } from '../../libs/pinia/synced-context'
import { conversationTopic, scopedTopic, SELF_INITIATED_NOTICE, SELF_INITIATED_SOURCE, toAutonomyInput } from '../../libs/self-initiated-speech/adapter'
import {
  createOutboundState,
  decideOutbound,
  OUTBOUND_POLICY_DEFAULTS,
  recordOutbound,
  recordOwnerMessage,
  setPaused,
} from '../../libs/self-initiated-speech/outbound-gate'
import { ACTIVE_SPEAK_POLICY, AUTONOMY_POLICY_DEFAULTS, SPEAK_POLICIES } from '../../libs/self-initiated-speech/speak-decision'
import { createSpeechTicker } from '../../libs/self-initiated-speech/ticker'
import { useChatStore } from '../chat'
import { readStoredRelationship } from '../chat/context-providers/relational-policy'
import { useChatSessionStore } from '../chat/session-store'
import { useMemoryStore } from '../memory'
import { useMindStore } from './mind'

/**
 * Why the loop is quiet, kept per character.
 *
 * In memory this answered nothing: every restart wiped it, and a silent companion has no other
 * surface. It is written on every refusal and every utterance. It lives at module scope so the
 * settings page can read the persisted copy from its own window, where the ticker never runs.
 */
const DIAGNOSTICS_KEY = 'castalia/self-initiated-diagnostics'

/**
 * The silence switch, as a plain key so another window can read it.
 *
 * The settings window and the first-run wizard own their own store instances, and `paused` used to
 * live in memory only: a restart forgot it, and a switch in another window never reached the ticker
 * that speaks. The ticker reads this key on every tick, so one window turning her off silences the
 * window that holds the election within a second.
 */
export const SILENCE_KEY = 'castalia/self-initiated-silent'

/** Whether the owner turned self-initiated speech off. A storage failure reads as "not silent". */
export function readSelfInitiatedSilent(): boolean {
  try {
    return localStorage.getItem(SILENCE_KEY) === 'true'
  }
  catch {
    return false
  }
}

/** Writes the silence switch. The ticker and every window read the same key. */
export function writeSelfInitiatedSilent(next: boolean): void {
  try {
    localStorage.setItem(SILENCE_KEY, String(next))
  }
  catch {
    // A blocked storage still leaves the in-memory switch in this window working.
  }
}

export interface LoopDiagnostics {
  lastReason?: string
  lastReasonAt?: number
  lastSpokeAt?: number
  /** 上一次她仍然问「你在忙吗」的时刻。感知已经能回答的问题被再问一次，要在面板上看得见。 */
  askedBusyAt?: number
  /** 开口前那一眼花了多久。超时预算够不够，看这个数，不靠猜。 */
  lookMs?: number
  gatedCount: number
  running: boolean
  updatedAt?: number
}

/**
 * The persisted diagnostics of one character.
 *
 * The settings window has its own store instance and never runs the ticker, so `store.diagnostics`
 * there is the initial empty value — printing it would be a fake green. This reads the copy the
 * stage window wrote.
 */
export function readSelfInitiatedDiagnostics(personaId: string): LoopDiagnostics | null {
  return readScoped<LoopDiagnostics | null>(DIAGNOSTICS_KEY, personaId, null)
}

/**
 * Lets the character open a turn without an owner message.
 *
 * The ticker reads the Castalia drives and the relationship stage, asks the
 * active policy, and then sends a notice. The model reads the notice and decides
 * what to say, or stays quiet. A notice keeps the turn out of the owner speech
 * path, so a stored reply stays a proactive message.
 */
export const useSelfInitiatedSpeechStore = defineStore('self-initiated-speech', () => {
  const castalia = useCastaliaPluginStore()
  const chat = useChatStore()
  const chatSession = useChatSessionStore()
  const memory = useMemoryStore()
  /**
   * The window election.
   *
   * Every renderer mounts this store: the stage window, the chat window, the settings window, and the
   * inlay overlay all load the same page. A ticker in each of them sends one notice per window for the
   * same pace, and each window keeps its own in-memory copy of the gate, so a fresh pace opens them all
   * at once and she answers three times in a row. Only the leader window speaks.
   */
  const synced = usePiniaSynced()

  const running = ref(false)
  let ticker: ReturnType<typeof createSpeechTicker> | undefined
  /** The election can settle after mount, so the ticker follows it instead of reading it once. */
  let stopLeadershipListener: (() => void) | undefined
  /**
   * Traffic control for self-initiated messages: gap, quiet hours, cap, slowdown.
   *
   * Persisted: the app restarts often (deploys, reboots), and an in-memory state
   * reset let her send the same notice again right after every reload —实测三次
   * 一模一样的「还是安静的」就是重载把 2 小时间隔抹掉了。
   */
  const OUTBOUND_KEY = 'castalia/self-initiated-outbound'
  /**
   * One pace per character.
   *
   * A shared pace meant the character that happened to speak last set the wait for every other card: her gap, her
   * daily count, and her unanswered run all applied to someone else. Each persona keeps its own now.
   */
  const outboundByPersona = new Map<string, ReturnType<typeof createOutboundState>>()

  function loadOutbound(personaId: string): ReturnType<typeof createOutboundState> {
    const fresh = createOutboundState(Date.now())
    const saved = readScoped<Record<string, unknown> | null>(OUTBOUND_KEY, personaId, null)
    if (!saved || typeof saved !== 'object')
      return fresh
    return {
      ...fresh,
      ...saved,
      recentTopics: saved.recentTopics && typeof saved.recentTopics === 'object' ? saved.recentTopics as ReturnType<typeof createOutboundState>['recentTopics'] : {},
    }
  }
  function outboundFor(personaId: string) {
    const cached = outboundByPersona.get(personaId)
    if (cached)
      return cached
    const state = loadOutbound(personaId)
    outboundByPersona.set(personaId, state)
    return state
  }
  function saveOutbound(personaId: string, state: ReturnType<typeof createOutboundState>) {
    outboundByPersona.set(personaId, state)
    writeScoped(OUTBOUND_KEY, personaId, state)
  }
  /** The character the current tick reads. The gate and the send use her pace, never another's. */
  let currentPersona = 'default'
  let outbound = createOutboundState(Date.now())
  /** The owner message time seen at the last tick, so a new one ends the unanswered run. */
  let lastOwnerAt: number | null = null
  /**
   * She looks at the screen the moment she is about to speak, because the last glance can be minutes
   * old: it answers "could you be interrupted a while ago", not now. A screen that turns her back
   * holds the next attempts, so a busy stretch costs one look instead of one per tick.
   */
  let blockedUntil = 0
  /** When the last "no input this tick" reason was written. One a minute is enough to read. */
  let lastSkipSavedAt = 0
  /** 上一个落盘的拒绝理由，与它的时间：同一理由连续成立时不再每秒落盘。 */
  let lastGatedReason = ''
  let lastGatedSavedAt = 0
  /** 冷却从哪一刻开始：只有比它更新的「可以说话」才能提前解除这段冷却。 */
  let blockedAt = 0
  /** How long a refusal from the screen holds before she looks again. */
  const SCREEN_BLOCK_RECHECK_MS = 5 * 60_000
  /**
   * 一次发送失败之后的冷却。
   *
   * 失败现在不计入节奏（没送出去就不算说过），所以必须另给一段冷却：不然 provider
   * 持续报错时，她会每秒重试一次，白烧请求。
   */
  const SEND_FAILED_RETRY_MS = 5 * 60_000
  /** Topic of the message the current tick would send. It comes from the tick's own read. */
  let currentTopic = 'idle'
  /** Why the last tick stayed silent. The diagnostics page reads it. */
  const lastGateReason = ref<string | undefined>(undefined)
  const paused = ref(readSelfInitiatedSilent())
  const gatedCount = ref(0)
  /**
   * The last-mile screen look can take as long as the vision model does.
   *
   * `speak` used to await it with no limit, so a slow or lost call held the utterance and the ticker
   * with it. Past this budget she speaks on what she already knows and records that the look was late.
   */
  const LOOK_BUDGET_MS = 20_000
  const diagnostics = ref<LoopDiagnostics>({ gatedCount: 0, running: false })
  let diagnosticsPersona = ''

  function loadDiagnostics(personaId: string) {
    diagnosticsPersona = personaId
    const saved = readScoped<LoopDiagnostics | null>(DIAGNOSTICS_KEY, personaId, null)
    // Read field by field: a spread of a wider record would keep a stale `running: true` from the
    // previous session, which is the one thing this file must not report as current.
    diagnostics.value = {
      lastReason: saved?.lastReason,
      lastReasonAt: saved?.lastReasonAt,
      lastSpokeAt: saved?.lastSpokeAt,
      askedBusyAt: saved?.askedBusyAt,
      lookMs: saved?.lookMs,
      updatedAt: saved?.updatedAt,
      gatedCount: Number(saved?.gatedCount ?? 0),
      running: false,
    }
    // 计数也要接着上次的来：只读进 `diagnostics` 而不回填 ref，重启后第一次拒绝会把
    // 持久化的总数覆盖成 1。
    gatedCount.value = diagnostics.value.gatedCount
  }
  function saveDiagnostics(patch: Partial<LoopDiagnostics>) {
    diagnostics.value = { ...diagnostics.value, ...patch, updatedAt: Date.now() }
    writeScoped(DIAGNOSTICS_KEY, diagnosticsPersona || currentPersona, diagnostics.value)
  }
  /** Whether the screen verdict still describes this moment. */

  /** Opens the ticker in this window. Only a window that holds the election calls it. */
  function beginTicker() {
    if (ticker) {
      return
    }

    ticker = createSpeechTicker({
      decide: SPEAK_POLICIES[ACTIVE_SPEAK_POLICY],
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: Math.random },
      // A speak that waits on a screen look plus a send may need a while; past the budget the loop
      // takes itself back and records speak-timeout instead of stopping for the rest of the day.
      speakBudgetMs: 180_000,
      now: Date.now,
      readInput: ({ now, lastSpokeAt }) => {
        /**
         * Why this tick had nothing to decide.
         *
         * The old code returned `undefined` and said nothing, so "she is quiet" and "the loop never
         * looked at anything" were the same observation. Each skip now leaves a reason behind.
         */
        const skip = (reason: string) => {
          if (now - lastSkipSavedAt > 60_000) {
            lastSkipSavedAt = now
            saveDiagnostics({ lastReason: reason, lastReasonAt: now })
          }
          return undefined
        }
        // A screen that just told her to stay quiet holds these ticks: no reads, no decision, no look.
        if (now < blockedUntil) {
          // 买断只在「那一句仍然成立」时有效。定时扫视或别处刚看过一眼、而且说可以说话，
          // 就没有理由让她按五分钟前的结论继续闭嘴；更新时间的比较保证不会用旧 `free` 解冻。
          const mind = useMindStore()
          // `>=`：同一毫秒内先被判定买断、随后那一眼说可以说话，也算「更新」；被买断的
          // 那一句只可能是 away/busy，所以同一时间戳上的 free 必然来自另一次判断。
          const fresh = mind.interruptionNow().level === 'free' && (mind.interruptVerdictAt ?? 0) >= blockedAt
          if (!fresh)
            return skip('screen-hold')
          blockedUntil = 0
        }
        const sessionId = chatSession.activeSessionId
        const cardId = sessionId ? chatSession.sessionMetas[sessionId]?.characterId : undefined
        // A turn in flight already speaks. A second notice would queue behind it.
        if (!sessionId)
          return skip('no-session')
        if (!cardId)
          return skip('no-card')
        if (!castalia.enabled)
          return skip('module-off')
        if (chat.sending)
          return skip('chat-busy')

        // Castalia records the drives under the persona that chats, not under the card id: a card id and a bank
        // persona are two names for one character (`default` reads `airi`). Reading the card id returned an empty
        // state whenever the two differ, so the drives never reached the decision.
        const personaId = memory.enabled ? memory.resolvePersona(cardId) : cardId
        const snapshot = castalia.snapshotFor(personaId)
        const messages = chatSession.getSessionMessagesIfLoaded(sessionId)
        // The subject follows the conversation, so a new subject is a new topic and the same subject still waits.
        if (personaId !== currentPersona || !diagnosticsPersona)
          loadDiagnostics(personaId)
        currentPersona = personaId
        outbound = outboundFor(personaId)
        currentTopic = scopedTopic(personaId, conversationTopic(messages) ?? snapshot.currentDesire)
        const input = toAutonomyInput({
          now,
          lastSpokeAt,
          messages,
          snapshot: {
            energy: snapshot.energy,
            currentDesire: snapshot.currentDesire,
            arousal: snapshot.vad?.arousal,
          },
          relationshipStage: readStoredRelationship(personaId)?.stage,
        })
        // The owner answered, so the unanswered run ends and the pace resets.
        if (input.lastUserAt !== null && (lastOwnerAt === null || input.lastUserAt > lastOwnerAt)) {
          outbound = recordOwnerMessage(outbound)
        }
        lastOwnerAt = input.lastUserAt
        return input
      },
      gate: ({ now }) => {
        // 开关可能是在另一个窗口（设置页 / 首启向导）按下的：它的 store 不跑 ticker，
        // 所以这里每跳读一次持久化的键，而不是只信本窗口内存里的 `paused`。
        if (paused.value || readSelfInitiatedSilent())
          return { allow: false, reason: 'paused' }
        const verdict = decideOutbound({ now, hour: new Date(now).getHours(), topic: currentTopic }, outbound)
        if (!verdict.allow)
          return { allow: false, reason: verdict.reason }
        // 出声前再看一眼她在干什么：屏幕在开会/全屏/游戏时，心里说一句就算了。
        // 裁决由 mind 的 lookAround 维护（每 5 分钟一次），这里只读，不额外抓屏。
        // 睡着时同理：夜间维护正在改库，这时候开口既打扰也容易被半成品记忆带偏。
        const mind = useMindStore()
        if (mind.asleep || mind.napping)
          return { allow: false, reason: mind.asleep ? 'sleeping' : 'napping' }
        // 一处裁决，两路证据：锁屏/长时间空闲（廉价路）与视觉那一句（昂贵路）。
        // `away` 和 `busy` 都不出声；`unknown` 放行，但上下文里写明不许问「你在忙吗」。
        const interruption = mind.interruptionNow()
        if (interruption.level === 'away' || interruption.level === 'busy') {
          // 一句话就把接下来五分钟买断：没有这一步，「到点了」会每秒成立一次，
          // 每秒跑一遍 snapshot/话题计算，再每秒拒绝一次。开口路径同样这么买断。
          blockedUntil = now + SCREEN_BLOCK_RECHECK_MS
          blockedAt = now
          return { allow: false, reason: `screen:${interruption.reason ?? interruption.level}` }
        }
        return { allow: true, reason: interruption.reason ?? verdict.reason }
      },
      onGated: (verdict) => {
        lastGateReason.value = verdict.reason
        // 一秒一跳：同一个理由会连续成立几百次。按「事件」记，不按 tick 记，
        // 否则计数每天上万，`localStorage` 还会被每秒同步写一次。
        const now = Date.now()
        if (verdict.reason === lastGatedReason && now - lastGatedSavedAt < 60_000)
          return
        lastGatedReason = verdict.reason
        lastGatedSavedAt = now
        gatedCount.value += 1
        saveDiagnostics({ gatedCount: gatedCount.value, lastReason: verdict.reason, lastReasonAt: now, running: true })
      },
      onStuck: () => {
        lastGateReason.value = 'speak-timeout'
        saveDiagnostics({ lastReason: 'speak-timeout', lastReasonAt: Date.now() })
      },
      speak: async () => {
        const sessionId = chatSession.activeSessionId
        if (!sessionId) {
          return
        }
        const mind = useMindStore()
        // 要开口的这一刻再看一眼屏幕。上一次 glance 可能是几分钟前的，回答的是「刚才能不能打扰」，
        // 不是现在：人可能已经走开、换了事，或者正被全屏挡着。看的结果同时也刷新了下面那段
        // innerContextLine 里的裁决，所以她不会拿旧画面去推断主人在干什么。
        // Bounded: a look that never returns must not take the loop with it.
        const lookStartedAt = Date.now()
        const looked = await Promise.race([
          mind.lookAround({ force: true }).then(() => 'done' as const).catch(() => 'failed' as const),
          new Promise<'timeout'>(resolve => setTimeout(resolve, LOOK_BUDGET_MS, 'timeout')),
        ])
        // 看完之后重新取时间：`now` 是看一眼之前的，用它算裁决等于用旧答案。
        const now = Date.now()
        if (looked === 'timeout')
          saveDiagnostics({ lastReason: 'look-timeout', lastReasonAt: now, lookMs: now - lookStartedAt })
        // 只认这一眼之后产生的裁决：超时、或视觉只回了描述没回裁决时，
        // 几分钟前的 `free` 不能当作「他现在不忙」的许可。
        const interruption = mind.interruptionSince(lookStartedAt)
        // 看完仍说不了话：锁屏/走开、或者屏幕在开会。没发出去就不记账——pace 不动，
        // 也不占用这次开口；先安静五分钟，而不是每秒再抓一次屏。
        if (interruption.level === 'away' || interruption.level === 'busy') {
          blockedUntil = now + SCREEN_BLOCK_RECHECK_MS
          blockedAt = now
          lastGateReason.value = `screen:${interruption.reason ?? interruption.level}`
          saveDiagnostics({ lastReason: lastGateReason.value, lastReasonAt: now })
          return
        }
        blockedUntil = 0
        lastGateReason.value = undefined
        // 状态机自己的上下文：把「刚才在心里想什么 / 此刻看到什么 / 现在的状态」一起带上。
        // 不带的话，她每次主动开口都像凭空冒一句，和自己那串自言自语接不上。
        const context = mind.innerContextLine(3, { minAgeMs: now - lookStartedAt })
        const text = context
          ? `${SELF_INITIATED_NOTICE}

${context}`
          : SELF_INITIATED_NOTICE
        const sent = await chat.notifyConversation(sessionId, { source: SELF_INITIATED_SOURCE, text })
        // Only a delivered line counts. A gated or failed send says nothing, and a line that does
        // not repeat a thought leaves every thought private.
        if (!sent?.ok || !sent.text) {
          // 没送到就不是「说了」：不推后 `lastSentAt`、不记话题、不算 unanswered。
          // 旧代码在发送之前记账，一次失败也照样消耗掉一小时的间隔。
          blockedUntil = now + SEND_FAILED_RETRY_MS
          blockedAt = now
          saveDiagnostics({ lastReason: 'send-failed', lastReasonAt: Date.now(), lookMs: now - lookStartedAt })
          return
        }
        // 真的送出去了才记账。时间取送达那一刻，不用看一眼之前的 `now`。
        const sentAt = Date.now()
        outbound = recordOutbound(outbound, { now: sentAt, hour: new Date(sentAt).getHours(), topic: currentTopic }, { random: Math.random })
        saveOutbound(currentPersona, outbound)
        saveDiagnostics({ lastReason: 'sent', lastReasonAt: sentAt, lastSpokeAt: sentAt, lookMs: sentAt - lookStartedAt, gatedCount: gatedCount.value, running: true })
        // 弱模型仍可能问「你在忙吗」。不拦、不改写已经生成的话，但要留下证据：
        // 这一句本该由感知回答，它出现在诊断里就说明上下文还没压住模型。
        // `free` 除外：她看得见主人不忙，问这一句只是习惯用语，不算猜错。
        if (interruption.level !== 'free' && asksIfBusy(sent.text))
          saveDiagnostics({ lastReason: 'asked-busy', lastReasonAt: sentAt, askedBusyAt: sentAt })
        mind.markSaidOutLoud(sent.text)
        // 说过一次就把无聊付掉：不然下一跳仍读到满格，每 10 分钟又想开口、又抓一次屏。
        mind.relieveAfterSpeaking()
        // Reaching out and getting an answer is an event in her state, not only a log line. A
        // shared video's answer lands the same way (`feedbackEffect`); this is the speech half:
        // one mood entry where the prompt and the panel both read it.
        castalia.recordMood(1, '我主动跟主人开口了', currentPersona)
      },
    })

    ticker.start()
    running.value = true
    saveDiagnostics({ running: true })
  }

  /** Stops the timer and keeps the election listener, so a later promotion can open it again. */
  function haltTicker() {
    ticker?.stop()
    ticker = undefined
    running.value = false
    saveDiagnostics({ running: false })
  }

  function start() {
    // The other windows stay silent. They hold no election, and each keeps its own copy of the gate, so a
    // fresh pace would open every one of them at the same instant and she would answer three times at once.
    stopLeadershipListener ??= synced.onLeadershipChange(isLeader => isLeader ? beginTicker() : haltTicker())
    if (synced.isLeader()) {
      beginTicker()
    }
  }

  function stop() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    haltTicker()
  }

  /**
   * Silences or resumes self-initiated speech.
   *
   * A hand-set pause outlives an owner message and a restart: the key is persisted, so the switch
   * holds across deploys and the ticker in the leading window sees a change made elsewhere.
   */
  function setSpeechPaused(next: boolean) {
    paused.value = next
    writeSelfInitiatedSilent(next)
    outbound = setPaused(outbound, next)
  }

  /** Forgets the day, the gaps, and the topics. A test and a new session both use it. */
  function resetOutbound(now: number = Date.now()) {
    outbound = createOutboundState(now)
    saveOutbound(currentPersona, outbound)
    lastOwnerAt = null
    gatedCount.value = 0
    lastGateReason.value = undefined
    // 重置也要放掉「屏幕说忙」的买断与落盘节流，否则重置后第一跳会被旧冷却继续按住，
    // 而且同一个理由在 60 秒内不会再记一次。
    blockedUntil = 0
    blockedAt = 0
    lastGatedReason = ''
    lastGatedSavedAt = 0
  }

  return {
    running,
    paused,
    lastGateReason,
    gatedCount,
    diagnostics,
    outboundPolicy: OUTBOUND_POLICY_DEFAULTS,
    setSpeechPaused,
    resetOutbound,
    start,
    stop,
  }
})
