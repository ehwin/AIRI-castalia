import type { BeatSyncDetectorState } from '@proj-airi/stage-shared/beat-sync'

import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { getBeatSyncState, isBeatSyncSupported, listenBeatSyncStateChange } from '@proj-airi/stage-shared/beat-sync'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import factorioIcon from '../assets/factorio-simple.png'

import { useLLM } from '../stores/ai/chat-llm/llm'
import { useMemoryStore } from '../stores/memory'
import { useArtistryStore } from '../stores/modules/artistry'
import { useConsciousnessStore } from '../stores/modules/consciousness'
import { useDiaryStore } from '../stores/modules/diary'
import { useDiscordStore } from '../stores/modules/discord'
import { useFactorioStore } from '../stores/modules/gaming-factorio'
import { useMinecraftStore } from '../stores/modules/gaming-minecraft'
import { useHearingStore } from '../stores/modules/hearing'
import { useHomeAssistantStore } from '../stores/modules/home-assistant'
import { usePerceptionStore } from '../stores/modules/perception'
import { useSpeechStore } from '../stores/modules/speech'
import { useStickersStore } from '../stores/modules/stickers'
import { useTwitterStore } from '../stores/modules/twitter'
import { useVideoStore } from '../stores/modules/video'
import { useVisionStore } from '../stores/modules/vision'
import { useWebSearchStore } from '../stores/modules/web-search'
import { useToolCardsStore } from '../stores/tool-cards'

export interface Module {
  id: string
  name: string
  description: string
  icon?: string
  iconColor?: string
  iconImage?: string
  to: string
  configured: boolean
  category: string
  /** What the running backend can do, when the module depends on one. Shown under the description. */
  detail?: string
  /** Switch is on but the backend cannot do the thing the module is named after. */
  degraded?: boolean
}

/**
 * 公开版才带的两页（记忆库 / 记忆服务）。
 *
 * 自己的非公开版继续用 3348 控制台，不需要这两页；公开版没有控制台，界面上必须有。
 * 构建时给 `VITE_AIRI_EDITION=public` 才会出现 —— 默认（不设）是私有版。
 */
const PUBLIC_EDITION = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AIRI_EDITION === 'public'

export function useModulesList() {
  const { t } = useI18n()

  // Initialize stores
  const consciousnessStore = useConsciousnessStore()
  const speechStore = useSpeechStore()
  const stickersStore = useStickersStore()
  const hearingStore = useHearingStore()
  const visionStore = useVisionStore()
  const discordStore = useDiscordStore()
  const twitterStore = useTwitterStore()
  const webSearchStore = useWebSearchStore()
  const videoStore = useVideoStore()
  const minecraftStore = useMinecraftStore()
  const factorioStore = useFactorioStore()
  const homeAssistantStore = useHomeAssistantStore()
  const artistryStore = useArtistryStore()
  const memoryStore = useMemoryStore()
  const castaliaStore = useCastaliaPluginStore()
  const llmStore = useLLM()
  const perceptionStore = usePerceptionStore()
  const diaryStore = useDiaryStore()
  const toolCardsStore = useToolCardsStore()
  const beatSyncState = ref<BeatSyncDetectorState>()
  const beatSyncSupported = isBeatSyncSupported()

  minecraftStore.initialize()

  const modulesList = computed<Module[]>(() => [
    {
      id: 'consciousness',
      name: t('settings.pages.modules.consciousness.title'),
      description: t('settings.pages.modules.consciousness.description'),
      icon: 'i-solar:ghost-bold-duotone',
      to: '/settings/modules/consciousness',
      configured: consciousnessStore.configured,
      category: 'essential',
      // A model whose tools a provider error switched off still shows as configured; say it here
      // instead of letting the module claim a capability the request no longer carries (F13).
      ...llmStore.toolsDisabledFor.length
        ? { detail: `工具已被服务商错误降级：${llmStore.toolsDisabledFor.join(', ')}（重启后重新探测）`, degraded: true }
        : {},
    },
    {
      id: 'speech',
      name: t('settings.pages.modules.speech.title'),
      description: t('settings.pages.modules.speech.description'),
      icon: 'i-solar:user-speak-rounded-bold-duotone',
      to: '/settings/modules/speech',
      configured: speechStore.configured,
      category: 'essential',
    },
    {
      id: 'hearing',
      name: t('settings.pages.modules.hearing.title'),
      description: t('settings.pages.modules.hearing.description'),
      icon: 'i-solar:microphone-3-bold-duotone',
      to: '/settings/modules/hearing',
      configured: hearingStore.configured,
      category: 'essential',
    },
    {
      id: 'vision',
      name: t('settings.pages.modules.vision.title'),
      description: t('settings.pages.modules.vision.description'),
      icon: 'i-solar:eye-closed-bold-duotone',
      to: '/settings/modules/vision',
      configured: visionStore.configured,
      category: 'essential',
    },
    {
      id: 'perception',
      name: t('settings.pages.modules.perception.title'),
      description: t('settings.pages.modules.perception.description'),
      icon: 'i-solar:eye-bold-duotone',
      to: '/settings/modules/perception',
      configured: perceptionStore.anyEnabled,
      category: 'essential',
    },
    {
      id: 'diary',
      name: t('settings.pages.modules.diary.title'),
      description: t('settings.pages.modules.diary.description'),
      icon: 'i-solar:notebook-bold-duotone',
      to: '/settings/modules/diary',
      configured: diaryStore.thoughts.length > 0,
      category: 'essential',
    },
    {
      id: 'thoughts',
      name: t('settings.pages.modules.thoughts.title'),
      description: t('settings.pages.modules.thoughts.description'),
      icon: 'i-solar:cloud-file-bold-duotone',
      to: '/settings/modules/thoughts',
      // The archive exists only when the bank keeps one; without it the page would say "nothing".
      configured: memoryStore.thoughtsSupported,
      category: 'essential',
    },
    {
      id: 'stickers',
      name: t('settings.pages.modules.stickers.title'),
      description: t('settings.pages.modules.stickers.description'),
      icon: 'i-solar:sticker-smile-circle-bold-duotone',
      to: '/settings/modules/stickers',
      configured: stickersStore.enabled,
      category: 'essential',
    },
    {
      id: 'web-search',
      name: t('settings.pages.modules.web-search.title'),
      description: t('settings.pages.modules.web-search.description'),
      icon: 'i-solar:magnifer-bold-duotone',
      to: '/settings/modules/web-search',
      configured: webSearchStore.configured,
      category: 'essential',
    },
    {
      id: 'video',
      name: t('settings.pages.modules.video.title'),
      description: t('settings.pages.modules.video.description'),
      icon: 'i-solar:videocamera-record-bold-duotone',
      to: '/settings/modules/video',
      configured: videoStore.configured,
      category: 'essential',
    },
    {
      id: 'video-share',
      name: t('settings.pages.modules.video-share.title'),
      description: t('settings.pages.modules.video-share.description'),
      icon: 'i-solar:share-circle-bold-duotone',
      to: '/settings/modules/video-share',
      configured: true,
      category: 'essential',
    },
    {
      id: 'artistry',
      name: t('settings.pages.modules.artistry.title'),
      description: t('settings.pages.modules.artistry.description'),
      icon: 'i-solar:palette-bold-duotone',
      to: '/settings/modules/artistry',
      configured: artistryStore.configured,
      category: 'essential',
    },
    // NOTICE:
    // 这里原本有 autoregressive-motion（Live2D MAGIC 的方法选择：VAR / AR-HMM）。
    // 上游 v0.13.1 的页面绑定在 settings store 的 method / arHmm* 上，而这一版 store 只有
    // profileId / skipMouthOpen / forceViewTarget —— 点进去每个控件都绑在 undefined 上。
    // 页面已随本次检测删除；等 store 补齐这三个字段，再把菜单项和页面一起加回来。

    {
      id: 'memory-short-term',
      name: t('settings.pages.modules.memory-short-term.title'),
      description: t('settings.pages.modules.memory-short-term.description'),
      icon: 'i-solar:bookmark-bold-duotone',
      to: '/settings/modules/memory-short-term',
      configured: false,
      category: 'essential',
    },
    {
      id: 'memory-long-term',
      name: t('settings.pages.modules.memory-long-term.title'),
      description: t('settings.pages.modules.memory-long-term.description'),
      icon: 'i-solar:book-bookmark-bold-duotone',
      to: '/settings/modules/memory-long-term',
      configured: memoryStore.enabled,
      category: 'essential',
      // A module that says "on" while its backend can only read rows is the bug this line answers.
      ...(memoryStore.backend
        ? {
            detail: memoryStore.backendNote(),
            degraded: memoryStore.enabled && !memoryStore.backend.capabilities.search && !memoryStore.backend.capabilities.recall,
          }
        : {}),
    },
    // 这两页只在公开版出现：自己的非公开版有 3348 控制台，不需要它们。
    ...(PUBLIC_EDITION
      ? [{
          id: 'memory-banks',
          name: t('settings.pages.modules.memory-banks.title'),
          description: t('settings.pages.modules.memory-banks.description'),
          icon: 'i-solar:database-bold-duotone',
          to: '/settings/modules/memory-banks',
          configured: memoryStore.enabled,
          category: 'essential' as const,
        }, {
          id: 'memory-api',
          name: t('settings.pages.modules.memory-api.title'),
          description: t('settings.pages.modules.memory-api.description'),
          icon: 'i-solar:key-square-bold-duotone',
          to: '/settings/modules/memory-api',
          // 有没有配置文件就是这件事的状态：没有就是还没接嵌入/反思后端。
          configured: Boolean(memoryStore.backend?.capabilities.ingest || memoryStore.backend?.capabilities.search),
          category: 'essential' as const,
        }]
      : []),
    {
      id: 'castalia',
      name: t('settings.pages.modules.castalia.title'),
      description: t('settings.pages.modules.castalia.description'),
      icon: 'i-solar:heart-pulse-bold-duotone',
      to: '/settings/modules/castalia',
      configured: castaliaStore.enabled,
      category: 'essential',
      ...(memoryStore.backend
        ? {
            detail: memoryStore.backendNote(),
            degraded: castaliaStore.enabled && !memoryStore.backend.capabilities.psyche && !memoryStore.backend.capabilities.selfCycle,
          }
        : {}),
    },
    {
      id: 'tool-cards',
      name: t('settings.pages.modules.tool-cards.title'),
      description: t('settings.pages.modules.tool-cards.description'),
      icon: 'i-solar:widget-5-bold-duotone',
      to: '/settings/modules/tool-cards',
      configured: toolCardsStore.enabled || toolCardsStore.replyCardsEnabled,
      category: 'essential',
    },
    {
      id: 'messaging-discord',
      name: t('settings.pages.modules.messaging-discord.title'),
      description: t('settings.pages.modules.messaging-discord.description'),
      icon: 'i-simple-icons:discord',
      to: '/settings/modules/messaging-discord',
      configured: discordStore.configured,
      category: 'messaging',
    },
    {
      id: 'x',
      name: t('settings.pages.modules.x.title'),
      description: t('settings.pages.modules.x.description'),
      icon: 'i-simple-icons:x',
      to: '/settings/modules/x',
      configured: twitterStore.configured,
      category: 'messaging',
    },
    {
      id: 'gaming-minecraft',
      name: t('settings.pages.modules.gaming-minecraft.title'),
      description: t('settings.pages.modules.gaming-minecraft.description'),
      iconColor: 'i-vscode-icons:file-type-minecraft',
      to: '/settings/modules/gaming-minecraft',
      configured: minecraftStore.configured,
      category: 'gaming',
    },
    {
      id: 'gaming-factorio',
      name: t('settings.pages.modules.gaming-factorio.title'),
      description: t('settings.pages.modules.gaming-factorio.description'),
      iconImage: factorioIcon,
      to: '/settings/modules/gaming-factorio',
      configured: factorioStore.configured,
      category: 'gaming',
    },
    {
      id: 'home-assistant',
      name: t('settings.pages.modules.home-assistant.title'),
      description: t('settings.pages.modules.home-assistant.description'),
      icon: 'i-solar:home-smile-bold-duotone',
      to: '/settings/modules/home-assistant',
      configured: homeAssistantStore.configured,
      category: 'essential',
    },
    {
      id: 'mcp-server',
      name: t('settings.pages.modules.mcp-server.title'),
      description: t('settings.pages.modules.mcp-server.description'),
      icon: 'i-solar:server-bold-duotone',
      to: '/settings/modules/mcp',
      configured: false,
      category: 'essential',
    },
    ...(beatSyncSupported
      ? [{
          id: 'beat-sync',
          name: t('settings.pages.modules.beat_sync.title'),
          description: t('settings.pages.modules.beat_sync.description'),
          icon: 'i-solar:music-notes-bold-duotone',
          to: '/settings/modules/beat-sync',
          configured: beatSyncState.value?.isActive ?? false,
          category: 'essential',
        }]
      : []),
  ])

  const categorizedModules = computed(() => {
    return modulesList.value.reduce((categories, module) => {
      const { category } = module
      if (!categories[category]) {
        categories[category] = []
      }
      categories[category].push(module)
      return categories
    }, {} as Record<string, Module[]>)
  })

  // Define category display names
  const categoryNames = computed(() => ({
    essential: t('settings.pages.modules.categories.essential'),
    messaging: t('settings.pages.modules.categories.messaging'),
    gaming: t('settings.pages.modules.categories.gaming'),
  }))

  // TODO(Makito): We can make this a reactive value from a synthetic store.
  onMounted(() => {
    if (!beatSyncSupported)
      return

    getBeatSyncState().then(initialState => beatSyncState.value = initialState)
    const removeListener = listenBeatSyncStateChange(newState => beatSyncState.value = { ...newState })
    onUnmounted(() => removeListener())
  })

  return {
    modulesList,
    categorizedModules,
    categoryNames,
  }
}
