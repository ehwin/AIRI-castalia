import { useSpeakingStore } from '@proj-airi/stage-ui/stores/audio'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

/**
 * Connects chat speech controls to the active Stage output host.
 *
 * Manual interruption stops generation and playback, then records an agent control event.
 * Mute is persisted by the shared store and also blocks future TTS sessions.
 */
export function useStopSpeakingButton(options: {
  /**
   * Reads speaking state from the renderer that owns playback.
   *
   * @default The current renderer's speaking store.
   */
  resolveSpeakingState?: () => boolean | Promise<boolean>
} = {}) {
  const { nowSpeaking } = storeToRefs(useSpeakingStore())
  const sessions = useChatSessionStore()
  const speechOutputControlStore = useSpeechOutputControlStore()
  const { speechMuted } = storeToRefs(speechOutputControlStore)

  const showStopSpeakingButton = computed(() => speechOutputControlStore.activeTurns.some(turn => turn.sessionId === sessions.activeSessionId))

  function stopSpeakingFromChat(sessionId = sessions.activeSessionId) {
    return speechOutputControlStore.requestStopSpeaking({ reason: 'manual-chat', sessionId })
  }

  function interruptSpeakingFromChat(sessionId = sessions.activeSessionId) {
    return speechOutputControlStore.requestStopSpeaking({ reason: 'manual-chat', sessionId })
  }

  function stopAllSpeaking() {
    return speechOutputControlStore.requestStopSpeaking({ reason: 'manual-all' })
  }

  async function toggleSpeechMuted() {
    try {
      await (options.resolveSpeakingState?.() ?? nowSpeaking.value)
    }
    catch {
      // Muting is the user action; a failed probe must not block it when an
      // auxiliary renderer cannot reach the output host during a reload.
      speechOutputControlStore.setSpeechMuted(!speechMuted.value)
      return
    }

    const muted = !speechMuted.value

    speechOutputControlStore.setSpeechMuted(muted)
  }

  return {
    showStopSpeakingButton,
    speechMuted,
    interruptSpeakingFromChat,
    stopSpeakingFromChat,
    stopAllSpeaking,
    toggleSpeechMuted,
  }
}
