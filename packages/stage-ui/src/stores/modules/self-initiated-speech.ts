import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { SELF_INITIATED_NOTICE, SELF_INITIATED_SOURCE, toAutonomyInput } from '../../libs/self-initiated-speech/adapter'
import { ACTIVE_SPEAK_POLICY, AUTONOMY_POLICY_DEFAULTS, SPEAK_POLICIES } from '../../libs/self-initiated-speech/speak-decision'
import { createSpeechTicker } from '../../libs/self-initiated-speech/ticker'
import { useChatStore } from '../chat'
import { readStoredRelationship } from '../chat/context-providers/relational-policy'
import { useChatSessionStore } from '../chat/session-store'

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

  const running = ref(false)
  let ticker: ReturnType<typeof createSpeechTicker> | undefined

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
        const personaId = sessionId ? chatSession.sessionMetas[sessionId]?.characterId : undefined
        // A turn in flight already speaks. A second notice would queue behind it.
        if (!sessionId || !personaId || !castalia.enabled || chat.sending) {
          return undefined
        }

        const snapshot = castalia.snapshotFor(personaId)
        return toAutonomyInput({
          now,
          lastSpokeAt,
          messages: chatSession.getSessionMessagesIfLoaded(sessionId),
          snapshot: {
            energy: snapshot.energy,
            currentDesire: snapshot.currentDesire,
            arousal: snapshot.vad?.arousal,
          },
          relationshipStage: readStoredRelationship(personaId)?.stage,
        })
      },
      speak: () => {
        const sessionId = chatSession.activeSessionId
        if (!sessionId) {
          return
        }
        return chat.notifyConversation(sessionId, { source: SELF_INITIATED_SOURCE, text: SELF_INITIATED_NOTICE })
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

  return { running, start, stop }
})
