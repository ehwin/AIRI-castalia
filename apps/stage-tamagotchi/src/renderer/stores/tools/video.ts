import type { ExecutableTool } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import type { VideoToolRuntime } from '@proj-airi/stage-ui/tools/video'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { usePiniaSynced } from '@proj-airi/stage-ui/libs/pinia'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useVideoStore } from '@proj-airi/stage-ui/stores/modules/video'
import { useVideoWatchStore } from '@proj-airi/stage-ui/stores/modules/video-watch'
import { TOOL_ICONS } from '@proj-airi/stage-ui/tools/icons'
import { createVideoTools } from '@proj-airi/stage-ui/tools/video'
import { defineStore } from 'pinia'
import { watch } from 'vue'

import { electronVideoProbe, electronVideoSheet, electronVideoText } from '../../../shared/eventa/video'

/**
 * Mounts the video tools in the desktop shell, where ffmpeg and the cache directory live.
 *
 * The module switch decides whether they exist at all: with the module off the tools are removed
 * from the tool store, so the model is not offered a capability the user turned off, and the
 * toolset prompt is dropped by the same gate in `stores/modules/video.ts`.
 */
export const useTamagotchiVideoToolsStore = defineStore('tamagotchi-video-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const videoStore = useVideoStore()
  const watchlistStore = useVideoWatchStore()
  const probeVideo = useElectronEventaInvoke(electronVideoProbe)
  const readText = useElectronEventaInvoke(electronVideoText)
  const drawSheet = useElectronEventaInvoke(electronVideoSheet)
  const toolIdPrefix = 'video:'

  // This shell has the engine; the module's switch now means "on" rather than "wanted".
  videoStore.markRuntimeAvailable()

  function registeredToolIds() {
    return llmToolsStore.tools
      .filter(tool => tool.id.startsWith(toolIdPrefix))
      .map(tool => tool.id)
  }

  function dispose() {
    llmToolsStore.removeToolsByIds(...registeredToolIds())
  }

  /**
   * The cookie and the picture switch are read per call, not captured, so changing either in the
   * settings page takes effect on the next question instead of after a restart.
   */
  const runtime: VideoToolRuntime = {
    probe: async source => await probeVideo({ source, cookie: videoStore.bilibiliCookie || undefined }),
    text: async source => await readText({ source, cookie: videoStore.bilibiliCookie || undefined }),
    sheet: async (request) => {
      const result = await drawSheet({
        source: request.source,
        fromSeconds: request.fromSeconds,
        toSeconds: request.toSeconds,
        cells: request.cells,
        cookie: videoStore.bilibiliCookie || undefined,
      })
      if ('error' in result)
        return result
      // Off, the sheet stays on disk and only the timecode index reaches the model: no image tokens.
      return { ...result, imageDataUrl: videoStore.attachImages ? result.imageDataUrl : '' }
    },
    watchlist: {
      enqueue: async ({ source, why }) => {
        const item = watchlistStore.enqueue({ source, why })
        if (!item)
          return { queued: watchlistStore.pending.length, message: 'Nothing was queued: that source is empty.' }
        const waiting = watchlistStore.pending.length
        return { queued: waiting, message: `Queued for later (${waiting} waiting). You can pick it up on your own when the moment is yours.` }
      },
      recall: async limit => watchlistStore.recall(limit),
    },
  }

  async function refresh() {
    if (!videoStore.enabled) {
      dispose()
      return
    }

    const tools = await createVideoTools(runtime, { depth: () => videoStore.depth })

    llmToolsStore.removeToolsByIds(...registeredToolIds())
    llmToolsStore.addTools(...tools.map(tool => ({
      ...tool,
      icon: TOOL_ICONS.video,
      // A module the user switched on is meant to be used without picking it in every request.
      defaultActive: true,
      id: `${toolIdPrefix}${tool.function.name}`,
    } satisfies ExecutableTool)))
  }

  // The module and its settings are synchronized state: the leader re-mounts the tools on any change.
  // A renderer that is not the leader has no executors, so it leaves the registry to the leader.
  const syncedPinia = usePiniaSynced()
  watch(
    () => [videoStore.enabled, videoStore.depth, videoStore.attachImages, videoStore.bilibiliCookie] as const,
    () => {
      if (!syncedPinia.isLeader())
        return
      void refresh().catch(error => console.warn('[video] Failed to refresh the video tools:', error))
    },
    { immediate: true },
  )

  return {
    dispose,
    refresh,
  }
}, {
  synced: {
    actions: ['dispose', 'refresh'],
    state: false,
  },
})
