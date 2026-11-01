import type { VideoWatchDecision } from '@proj-airi/stage-ui/libs/video-watch/policy'

import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { usePiniaSynced } from '@proj-airi/stage-ui/libs/pinia'
import { decideVideoWatch, VIDEO_WATCH_POLICY_DEFAULTS } from '@proj-airi/stage-ui/libs/video-watch/policy'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useVideoStore } from '@proj-airi/stage-ui/stores/modules/video'
import { useVideoShareStore } from '@proj-airi/stage-ui/stores/modules/video-share'
import { useVideoWatchStore } from '@proj-airi/stage-ui/stores/modules/video-watch'
import { cellsForDepth, timestampOfSeconds } from '@proj-airi/stage-ui/tools/video'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { electronVideoProbe, electronVideoSheet, electronVideoText } from '../../shared/eventa/video'

/**
 * Lets her start a video on her own.
 *
 * The mount is deliberately not an LLM loop: a prompt run every minute to answer "not now" would
 * cost more than the videos. Instead the queue holds what she decided she wants to watch (the
 * `builtIn_videoRemember` tool, or a link the owner sent), and a pure policy decides whether this
 * tick is hers — idle chat, outside quiet hours, under the daily cap, and with odds that rise with
 * how long the clip waited and how curious she is right now (her own mood and arousal).
 *
 * What she watches is recorded as a digest in her long-term memory, so she can bring it up later
 * with timecodes instead of a vague "我好像看过".
 */

/** How often the policy is asked. A minute keeps the app cheap and the decision timely enough. */
const TICK_MS = 60_000

export const useVideoAutonomyStore = defineStore('tamagotchi-video-autonomy', () => {
  const videoStore = useVideoStore()
  const watchlist = useVideoWatchStore()
  const share = useVideoShareStore()
  const chatStore = useChatStore()
  // A card owns a persona, and long-term memory is stored per persona.
  const cardStore = useAiriCardStore()
  const castalia = useCastaliaPluginStore()
  const memory = useMemoryStore()
  // Only the leader window runs the timer: every chat renderer mounts this store, and two tickers
  // would race for the same queue item.
  const synced = usePiniaSynced()

  const probeVideo = useElectronEventaInvoke(electronVideoProbe)
  const readText = useElectronEventaInvoke(electronVideoText)
  const drawSheet = useElectronEventaInvoke(electronVideoSheet)

  /** The last moment a conversation ended; she never starts a clip mid-turn. */
  const lastActivityAt = ref(Date.now())
  const lastDecision = ref<VideoWatchDecision>()
  const watching = ref<string | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined

  const running = computed(() => videoStore.enabled && videoStore.autonomous)

  /** Her curiosity, 0..1: mood scaled to ±10 plus arousal, then clipped. */
  function curiosityOf(): number {
    const snapshot = castalia.snapshotFor()
    const mood = (snapshot.currentMood ?? 0) / 10
    const arousal = snapshot.vad?.arousal ?? 0
    return Math.min(1, Math.max(0, 0.5 + mood * 0.35 + arousal * 0.3))
  }

  /**
   * The digest she keeps of one clip.
   *
   * A transcript, when the clip has captions, is the cheapest complete answer and the only part
   * that can be quoted. Without one, one contact sheet gives her the shape of the clip and the
   * timecodes she can point at.
   */
  async function digestOf(item: { source: string, title?: string }, cookie?: string): Promise<string | undefined> {
    const probe = await probeVideo({ source: item.source, cookie })
    if ('error' in probe)
      return undefined

    const header = `${probe.title ?? item.title ?? item.source}（${timestampOfSeconds(probe.durationSeconds)}，${probe.width}×${probe.height}）`

    if (probe.hasTextTrack) {
      const text = await readText({ source: item.source, cookie })
      if (!('error' in text)) {
        const head = text.text.split('\n').slice(0, 40).join('\n')
        return `${header}\n\n${text.origin === 'platform' ? '字幕' : '内嵌字幕'}前 ${Math.min(40, text.lines)} 条:\n${head}`
      }
    }

    const sheet = await drawSheet({ source: item.source, cells: cellsForDepth(videoStore.depth), cookie })
    if ('error' in sheet)
      return undefined

    const cells = sheet.cells.slice(0, 12).map(cell => `${timestampOfSeconds(cell.atSeconds)}`).join(' ')
    return `${header}\n\n没有台词轨，只看了一张分镜（${sheet.cells.length} 格），关键时间点: ${cells}`
  }

  /** Watches the oldest queued clip. Returns the id it marked, or undefined when nothing was left. */
  async function watchNext(): Promise<string | undefined> {
    const item = watchlist.pending[0]
    if (!item || watching.value)
      return undefined

    watching.value = item.id
    try {
      const cookie = videoStore.bilibiliCookie || undefined
      const note = await digestOf(item, cookie)
      if (!note) {
        // A link that no longer resolves is dropped rather than retried every tick forever.
        watchlist.skip(item.id)
        return undefined
      }

      watchlist.markWatched(item.id, note)
      // A watched clip goes up on the panel: sharing is what makes watching worth doing, and the
      // owner's answer is what teaches her which clips to pick next.
      share.publish({
        source: item.source,
        title: share.headlineFor(note).split('（')[0] || item.title,
        headline: item.why || '刚看完，想给你看这一段',
        why: item.why,
        note,
      })
      const persona = cardStore.activeCardId
      memory.write({
        name: `看过的片子 ${note.split('\n')[0]!.slice(0, 40)}`,
        description: `她自己决定看的一条视频（${new Date().toLocaleDateString('sv-SE')}）`,
        body: note,
      }, persona)
      return item.id
    }
    finally {
      watching.value = null
    }
  }

  /** One tick of the policy. Public so a test, or the settings page, can ask without timers. */
  async function tick(now: number = Date.now(), random: number = Math.random()): Promise<VideoWatchDecision> {
    share.applyPending()

    const decision = decideVideoWatch({
      now,
      idleMs: now - lastActivityAt.value,
      queueAgeMs: watchlist.oldestPendingAgeMs(now),
      pending: watchlist.pending.length,
      watchedToday: watchlist.watchedToday(now),
      lastWatchedAt: watchlist.lastWatchedAt,
      curiosity: curiosityOf(),
      random,
    }, VIDEO_WATCH_POLICY_DEFAULTS)

    lastDecision.value = decision
    if (decision.watch)
      await watchNext()
    return decision
  }

  function start() {
    if (timer)
      return
    timer = setInterval(() => {
      void tick().catch(error => console.warn('[video] autonomy tick failed:', error))
    }, TICK_MS)
  }

  function stop() {
    if (timer)
      clearInterval(timer)
    timer = undefined
  }

  // A turn ending, not starting, is what makes her idle: her reply is the last thing said.
  watch(() => chatStore.sending, (sending, wasSending) => {
    if (wasSending && !sending)
      lastActivityAt.value = Date.now()
  })

  watch(running, (isRunning) => {
    if (isRunning && synced.isLeader())
      start()
    else
      stop()
  }, { immediate: true })

  // Leadership moves between windows; the ticker follows it.
  void synced.onLeadershipChange((isLeader) => {
    if (isLeader && running.value)
      start()
    else
      stop()
  })

  return {
    running,
    watching,
    lastDecision,
    lastActivityAt,
    tick,
    watchNext,
    start,
    stop,
  }
}, {
  synced: { actions: ['start', 'stop'], state: false },
})
