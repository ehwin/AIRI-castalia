import type { VideoDepth } from '../../tools/video'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { VIDEO_TOOLSET_PROMPT } from '../../tools/video'
import { useLlmToolsetPromptsStore } from '../ai/chat-llm/toolset-prompts'

/**
 * Settings of the video module: whether the character can watch clips, and how closely.
 *
 * The tools themselves live in `tools/video.ts` and run in the desktop shell; this store is the
 * switch and the guidance. The prompt is registered under the same `configured` gate as the tools,
 * so the model is never told to call a tool that this build did not mount.
 */
export const useVideoStore = defineStore('video', () => {
  const toolsetPromptsStore = useLlmToolsetPromptsStore()

  const enabled = useLocalStorageManualReset<boolean>('settings/video/enabled', false)
  /** `skim` is one sheet, `read` adds a transcript and 16 cells, `deep` uses 25 cells and expects zooms. */
  const depth = useLocalStorageManualReset<VideoDepth>('settings/video/depth', 'read')
  /**
   * Sends the sheet as a picture. Off, only the timecode index reaches the model, which is what a
   * text-only chat model wants: no vision call, no per-image tokens.
   */
  const attachImages = useLocalStorageManualReset<boolean>('settings/video/attach-images', true)
  /**
   * Bilibili cookie, `SESSDATA=…; bili_jct=…`. Without it most videos have no captions and 480p is
   * the best quality, so the transcript path stops at "no text track".
   */
  const bilibiliCookie = useLocalStorageManualReset<string>('settings/video/bilibili-cookie', '')

  /**
   * Lets her pick a queued clip up on her own, when the moment is hers.
   *
   * Off by default: watching something without being asked is a bigger step than reading a link
   * that was pasted, and the owner should turn it on deliberately.
   */
  const autonomous = useLocalStorageManualReset<boolean>('settings/video/autonomous', false)
  /**
   * `true` once the desktop shell has mounted the tools. The web build has no ffmpeg and no cache
   * directory, so the switch there would turn on a prompt with nothing behind it.
   */
  const runtimeAvailable = ref(false)

  /** The switch is honoured only where the tools exist: mount the runtime first, then enable. */
  const configured = computed(() => enabled.value && runtimeAvailable.value)

  function markRuntimeAvailable() {
    runtimeAvailable.value = true
  }

  watch(configured, (isConfigured) => {
    if (isConfigured)
      toolsetPromptsStore.registerToolsetPrompts('video', [{ id: 'video', content: VIDEO_TOOLSET_PROMPT }])
    else
      toolsetPromptsStore.clearToolsetPrompts('video')
  }, { immediate: true })

  function resetState() {
    enabled.reset()
    depth.reset()
    attachImages.reset()
    bilibiliCookie.reset()
    autonomous.reset()
  }

  return {
    enabled,
    depth,
    attachImages,
    bilibiliCookie,
    autonomous,
    runtimeAvailable,
    configured,
    markRuntimeAvailable,
    resetState,
  }
})
