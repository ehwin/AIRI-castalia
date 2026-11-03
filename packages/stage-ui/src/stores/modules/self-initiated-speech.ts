import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { defineStore } from 'pinia'
import { ref } from 'vue'

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
import { useMindStore } from './mind'
import { readStoredRelationship } from '../chat/context-providers/relational-policy'
import { useChatSessionStore } from '../chat/session-store'
import { readScoped, writeScoped } from '../../libs/persona-scope'
import { useMemoryStore } from '../memory'

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

  const running = ref(false)
  let ticker: ReturnType<typeof createSpeechTicker> | undefined
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
  /** Topic of the message the current tick would send. It comes from the tick's own read. */
  let currentTopic = 'idle'
  /** Why the last tick stayed silent. The diagnostics page reads it. */
  const lastGateReason = ref<string | undefined>(undefined)
  const paused = ref(false)
  const gatedCount = ref(0)


  function start() {
    if (ticker) {
      return
    }

    ticker = createSpeechTicker({
      decide: SPEAK_POLICIES[ACTIVE_SPEAK_POLICY],
      policy: { ...AUTONOMY_POLICY_DEFAULTS, random: Math.random },
      now: Date.now,
      readInput: ({ now, lastSpokeAt }) => {
        const sessionId = chatSession.activeSessionId
        const cardId = sessionId ? chatSession.sessionMetas[sessionId]?.characterId : undefined
        // A turn in flight already speaks. A second notice would queue behind it.
        if (!sessionId || !cardId || !castalia.enabled || chat.sending) {
          return undefined
        }

        // Castalia records the drives under the persona that chats, not under the card id: a card id and a bank
        // persona are two names for one character (`default` reads `airi`). Reading the card id returned an empty
        // state for every card whose persona differs, so the drives never reached the decision.
        const personaId = memory.enabled ? memory.resolvePersona(cardId) : cardId
        const snapshot = castalia.snapshotFor(personaId)
        const messages = chatSession.getSessionMessagesIfLoaded(sessionId)
        // The subject follows the conversation, so a new subject is a new topic and the same subject still waits.
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
        if (!mind.interruptAllowed)
          return { allow: false, reason: `screen:${mind.interruptReason ?? 'busy'}` }
        return { allow: true, reason: verdict.reason }
      },
      onGated: (verdict) => {
        gatedCount.value += 1
        lastGateReason.value = verdict.reason
      },
      speak: () => {
        const sessionId = chatSession.activeSessionId
        if (!sessionId) {
          return
        }
        const now = Date.now()
        outbound = recordOutbound(outbound, { now, hour: new Date(now).getHours(), topic: currentTopic })
        saveOutbound(currentPersona, outbound)
        lastGateReason.value = undefined
        // 状态机自己的上下文：把「刚才在心里想什么 / 此刻看到什么 / 现在的状态」一起带上。
        // 不带的话，她每次主动开口都像凭空冒一句，和自己那串自言自语接不上。
        const context = useMindStore().innerContextLine(3)
        const text = context ? `${SELF_INITIATED_NOTICE}

${context}` : SELF_INITIATED_NOTICE
        return chat.notifyConversation(sessionId, { source: SELF_INITIATED_SOURCE, text })
      },
    })

    ticker.start()
    running.value = true
  }

  function stop() {
    ticker?.stop()
    ticker = undefined
    running.value = false
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
    outboundPolicy: OUTBOUND_POLICY_DEFAULTS,
    setSpeechPaused,
    resetOutbound,
    start,
    stop,
  }
})
