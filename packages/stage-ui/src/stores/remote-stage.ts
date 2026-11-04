import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'

import { useModsServerChannelStore } from './mods/api/channel-server'
import { useSpeechOutputControlStore } from './speech-output-control'

/**
 * The phone stage announces itself under the web app's module name; the desktop is the tamagotchi one.
 * A browser tab uses the same name, so the UI says "another device", not "the phone".
 */
const REMOTE_STAGE_MODULE = 'proj-airi:stage-web'

interface RemoteStagePeer {
  id: string
  name: string
}

/**
 * Tracks the stage peers the channel server reports, so the desktop can hand its voice to a device that is
 * really connected.
 *
 * Use when:
 * - The desktop must know whether another stage device is online before it goes silent
 * - A default-on switch decides whether an online device takes the voice
 *
 * Expects:
 * - The channel server to broadcast `registry:modules:sync` on connect and de-announce
 *
 * Returns:
 * - `remoteOnline` from that registry, the persisted switch, and the resulting local mute
 *
 * The registry is the only presence source: it drops a peer when the connection closes, so the indicator
 * cannot stay green for a device that left.
 */
export const useRemoteStageStore = defineStore('remote-stage', () => {
  const channel = useModsServerChannelStore()
  const speechControl = useSpeechOutputControlStore()

  /** Default on: a device that joins the channel is the one that should speak. */
  const preferRemoteVoice = useLocalStorage('settings/speech/remote-stage-voice', true)
  const peers = shallowRef<RemoteStagePeer[]>([])
  const lastTurnAt = ref<number | null>(null)
  const listening = ref(false)
  /** A window that opened after the last sync must not touch the mute before it knows the registry. */
  const registrySeen = ref(false)
  const remoteOnline = computed(() => peers.value.length > 0)

  /**
   * Subscribes to the registry and keeps the local mute in step with it.
   *
   * Starting twice must not add a second listener. Only the host calls this: a client that tracked
   * presence would silence itself.
   */
  function start() {
    if (listening.value)
      return
    listening.value = true

    channel.onEvent('registry:modules:sync', (event) => {
      const modules = event.data?.modules ?? []
      peers.value = modules
        .filter(module => module?.name === REMOTE_STAGE_MODULE && typeof module.identity?.id === 'string')
        .map(module => ({ id: module.identity!.id, name: String(module.name) }))
      registrySeen.value = true
    })

    // Online device → silent desktop. Device gone → the desktop speaks again, so losing the link cannot
    // leave the user with no voice at all.
    watch([remoteOnline, preferRemoteVoice, registrySeen], ([online, prefer, seen]) => {
      if (!seen)
        return
      speechControl.setSpeechMuted(prefer && online)
    }, { immediate: true })
  }

  /** Set by a turn that carries a `pocket:` binding, which is proof the device really sent something. */
  function notePocketTurn() {
    lastTurnAt.value = Date.now()
  }

  /**
   * A manual "speak here" on the stage must also give up the handover, or the next registry event would mute
   * this machine again right after the user asked for its voice.
   */
  function setRemoteVoicePreferred(preferred: boolean) {
    preferRemoteVoice.value = preferred
  }

  return { preferRemoteVoice, peers, remoteOnline, lastTurnAt, listening, start, notePocketTurn, setRemoteVoicePreferred }
})
