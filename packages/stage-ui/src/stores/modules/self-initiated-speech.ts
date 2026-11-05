import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
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
  /** How long a refusal from the screen holds before she looks again. */
  const SCREEN_BLOCK_RECHECK_MS = 5 * 60_000
  /** Topic of the message the current tick would send. It comes from the tick's own read. */
  let currentTopic = 'idle'
  /** Why the last tick stayed silent. The diagnostics page reads it. */
  const lastGateReason = ref<string | undefined>(undefined)
  const paused = ref(false)
  const gatedCount = ref(0)
  /**
   * The last-mile screen look can take as long as the vision model does.
   *
   * `speak` used to await it with no limit, so a slow or lost call held the utterance and the ticker
   * with it. Past this budget she speaks on what she already knows and records that the look was late.
   */
  const LOOK_BUDGET_MS = 20_000
  /**
   * A screen verdict only describes the moment it was taken.
   *
   * Vision can fail for hours. Holding the last `false` would keep her quiet with nothing left to
   * refresh it, so an old verdict stops counting as a refusal.
   */
  const SCREEN_VERDICT_TTL_MS = 15 * 60_000
  /**
   * Why the loop is quiet, kept per character.
   *
   * In memory this answered nothing: every restart wiped it, and a silent companion has no other
   * surface. It is written on every refusal and every utterance.
   */
  const DIAGNOSTICS_KEY = 'castalia/self-initiated-diagnostics'
  interface LoopDiagnostics {
    lastReason?: string
    lastReasonAt?: number
    lastSpokeAt?: number
    gatedCount: number
    running: boolean
    updatedAt?: number
  }
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
      updatedAt: saved?.updatedAt,
      gatedCount: Number(saved?.gatedCount ?? 0),
      running: false,
    }
  }
  function saveDiagnostics(patch: Partial<LoopDiagnostics>) {
    diagnostics.value = { ...diagnostics.value, ...patch, updatedAt: Date.now() }
    writeScoped(DIAGNOSTICS_KEY, diagnosticsPersona || currentPersona, diagnostics.value)
  }
  /** Whether the screen verdict still describes this moment. */
  function screenVerdictIsFresh(mind: { interruptVerdictAt?: number }, now: number) {
    return typeof mind.interruptVerdictAt === 'number' && now - mind.interruptVerdictAt < SCREEN_VERDICT_TTL_MS
  }

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
          return skip('screen-hold')
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
        // state for every card whose persona differs, so the drives never reached the decision.
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
        const verdict = decideOutbound({ now, hour: new Date(now).getHours(), topic: currentTopic }, outbound)
        if (!verdict.allow)
          return { allow: false, reason: verdict.reason }
        // 出声前再看一眼她在干什么：屏幕在开会/全屏/游戏时，心里说一句就算了。
        // 裁决由 mind 的 lookAround 维护（每 5 分钟一次），这里只读，不额外抓屏。
        // 睡着时同理：夜间维护正在改库，这时候开口既打扰也容易被半成品记忆带偏。
        const mind = useMindStore()
        if (mind.asleep || mind.napping)
          return { allow: false, reason: mind.asleep ? 'sleeping' : 'napping' }
        // Only a verdict taken a moment ago is a refusal. An old one means vision stopped answering,
        // which is not the same as the owner being busy.
        if (!mind.interruptAllowed && screenVerdictIsFresh(mind, now))
          return { allow: false, reason: `screen:${mind.interruptReason ?? 'busy'}` }
        return { allow: true, reason: verdict.reason }
      },
      onGated: (verdict) => {
        gatedCount.value += 1
        lastGateReason.value = verdict.reason
        saveDiagnostics({ gatedCount: gatedCount.value, lastReason: verdict.reason, lastReasonAt: Date.now(), running: true })
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
        const now = Date.now()
        // 要开口的这一刻再看一眼屏幕。上一次 glance 可能是几分钟前的，回答的是「刚才能不能打扰」，
        // 不是现在：人可能已经走开、换了事，或者正被全屏挡着。看的结果同时也刷新了下面那段
        // innerContextLine 里的「你此刻看到」，所以她不会拿旧画面去推断主人在干什么。
        // Bounded: a look that never returns must not take the loop with it.
        const looked = await Promise.race([
          mind.lookAround({ force: true }).then(() => 'done' as const).catch(() => 'failed' as const),
          new Promise<'timeout'>(resolve => setTimeout(resolve, LOOK_BUDGET_MS, 'timeout')),
        ])
        if (looked === 'timeout')
          saveDiagnostics({ lastReason: 'look-timeout', lastReasonAt: Date.now() })
        if (!mind.interruptAllowed && screenVerdictIsFresh(mind, now)) {
          // 没发出去就不记账：pace 不动，也不占用这次开口。屏幕上不方便时先安静一会儿，不是每秒重试。
          blockedUntil = now + SCREEN_BLOCK_RECHECK_MS
          lastGateReason.value = `screen:${mind.interruptReason ?? 'busy'}`
          saveDiagnostics({ lastReason: lastGateReason.value, lastReasonAt: now })
          return
        }
        blockedUntil = 0
        outbound = recordOutbound(outbound, { now, hour: new Date(now).getHours(), topic: currentTopic })
        saveOutbound(currentPersona, outbound)
        lastGateReason.value = undefined
        saveDiagnostics({ lastReason: 'sent', lastReasonAt: now, lastSpokeAt: now, gatedCount: gatedCount.value, running: true })
        // 状态机自己的上下文：把「刚才在心里想什么 / 此刻看到什么 / 现在的状态」一起带上。
        // 不带的话，她每次主动开口都像凭空冒一句，和自己那串自言自语接不上。
        const context = mind.innerContextLine(3)
        const text = context
          ? `${SELF_INITIATED_NOTICE}

${context}`
          : SELF_INITIATED_NOTICE
        return chat.notifyConversation(sessionId, { source: SELF_INITIATED_SOURCE, text })
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
   * A hand-set pause outlives an owner message: only this call lifts it. The
   * unanswered pause lifts by itself, because the owner answering is an answer.
   */
  function setSpeechPaused(next: boolean) {
    paused.value = next
    outbound = setPaused(outbound, next)
  }

  /** Forgets the day, the gaps, and the topics. A test and a new session both use it. */
  function resetOutbound(now: number = Date.now()) {
    outbound = createOutboundState(now)
    saveOutbound(currentPersona, outbound)
    lastOwnerAt = null
    gatedCount.value = 0
    lastGateReason.value = undefined
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
