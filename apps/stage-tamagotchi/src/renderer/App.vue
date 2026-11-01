<script setup lang="ts">
import type { ArtistrySyncPayload } from '@proj-airi/stage-shared'

import { defineInvokeHandler } from '@moeru/eventa'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { artistrySyncConfig } from '@proj-airi/stage-shared'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { updateModelAssetStatus, useInferencePreload } from '@proj-airi/stage-ui/composables'
import { usePiniaSynced } from '@proj-airi/stage-ui/libs/pinia'
import { isSherpawModelBundled, setSherpawModelAssetHost } from '@proj-airi/stage-ui/libs/providers/providers/sherpaw/model-assets'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useArtistryStore } from '@proj-airi/stage-ui/stores/modules/artistry'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useMindStore } from '@proj-airi/stage-ui/stores/modules/mind'
import { usePerceptionStore } from '@proj-airi/stage-ui/stores/modules/perception'
import { useSelfInitiatedSpeechStore } from '@proj-airi/stage-ui/stores/modules/self-initiated-speech'
import { castaliaMemoryPsyche, castaliaMemorySelfCycle } from '../shared/eventa/castalia-memory'
import { createScreenSense } from './libs/screen-sense'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useSettings, useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { useSettingsStageModel } from '@proj-airi/stage-ui/stores/settings/stage-model'
import { useTheme } from '@proj-airi/ui'
import { isEqual } from 'es-toolkit'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, watch, watchEffect } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import ResizeHandler from './components/ResizeHandler.vue'

import {
  electronGetServerChannelConfig,
  electronGodotStageGetStatus,
  electronGodotStageStatusChanged,
  electronSettingsNavigate,
  i18nGetLocale,
  i18nSetLocale,
} from '../shared/eventa'
import { castaliaMemoryForget, castaliaMemoryIngest, castaliaMemoryList, castaliaMemoryRecall, castaliaMemorySave } from '../shared/eventa/castalia-memory'
import { electronModelAssetCancel, electronModelAssetEnsure, electronModelAssetRemove, electronModelAssetsClear, electronModelAssetsList, electronModelAssetStatusChanged } from '../shared/eventa/model-assets'
import {
  electronPluginUpdateCapability,
  pluginProtocolListProviders,
  pluginProtocolListProvidersEventName,
} from '../shared/eventa/plugin/capabilities'
import {
  electronPluginCancelDirectoryImport,
  electronPluginCommitDirectoryImport,
  electronPluginInspect,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginPrepareDirectoryImport,
  electronPluginSetAutoReload,
  electronPluginSetEnabled,
  electronPluginUnload,
} from '../shared/eventa/plugin/host'
import { electronPluginToolsChanged } from '../shared/eventa/plugin/tools'
import { initializeIOTraceHubBridge } from './bridges/io-trace-hub'
import { initializeStageThreeRuntimeTraceBridge } from './bridges/stage-three-runtime-trace'
import { useLanguage } from './composables/use-language'
import { useFullscreenStore } from './stores/fullscreen'
import { useServerChannelSettingsStore } from './stores/settings/server-channel'
import { useStageWindowLifecycleStore } from './stores/stage-window-lifecycle'
import {
  useTamagotchiBuiltinToolsStore,
  useTamagotchiHomeAssistantStore,
  useTamagotchiMcpToolsStore,
  useTamagotchiPluginToolsStore,
} from './stores/tools'
import { resolveInitialRendererRoutePath, resolveRendererWindowContext } from './window-context'

const { isDark: dark } = useTheme()
const settingsStore = useSettings()
const { language, themeColorsHue, themeColorsHueDynamic } = storeToRefs(settingsStore)
const router = useRouter()
const route = useRoute()
const context = useElectronEventaContext()
const memoryStore = useMemoryStore()
const listCastaliaMemory = useElectronEventaInvoke(castaliaMemoryList)
const saveCastaliaMemory = useElectronEventaInvoke(castaliaMemorySave)
const forgetCastaliaMemory = useElectronEventaInvoke(castaliaMemoryForget)
const recallCastaliaMemory = useElectronEventaInvoke(castaliaMemoryRecall)
const ingestCastaliaMemory = useElectronEventaInvoke(castaliaMemoryIngest)
memoryStore.attachRemote({
  list: listCastaliaMemory,
  save: saveCastaliaMemory,
  forget: async (entry) => { await forgetCastaliaMemory(entry) },
  recall: query => recallCastaliaMemory(query),
  // 每轮对话的写回入口：没有它，她只说、不记。
  ingest: turn => ingestCastaliaMemory(turn),
})
void memoryStore.hydrate()
const listModelAssets = useElectronEventaInvoke(electronModelAssetsList)
const ensureModelAsset = useElectronEventaInvoke(electronModelAssetEnsure)
const cancelModelAsset = useElectronEventaInvoke(electronModelAssetCancel)
const removeModelAsset = useElectronEventaInvoke(electronModelAssetRemove)
const clearModelAssets = useElectronEventaInvoke(electronModelAssetsClear)
const stopModelAssetStatus = context.value.on(electronModelAssetStatusChanged, (event) => {
  if (event.body && !isSherpawModelBundled(event.body.id))
    updateModelAssetStatus(event.body)
})
setSherpawModelAssetHost({
  fetch: (model, fileName, signal) => fetch(
    `airi-model://assets/${encodeURIComponent(model.id)}/${encodeURIComponent(model.revision)}/${fileName}`,
    { signal },
  ),
  list: listModelAssets,
  ensure: ensureModelAsset,
  cancel: cancelModelAsset,
  remove: removeModelAsset,
  clear: clearModelAssets,
})
const getMainLocale = useElectronEventaInvoke(i18nGetLocale)
const setLocale = useElectronEventaInvoke(i18nSetLocale)
const windowContext = resolveRendererWindowContext()
const initialRoutePath = resolveInitialRendererRoutePath(route.path)
const chatStore = useChatStore()
const mindStore = useMindStore()
// Her eyes: the screen, summarised to one line per look by the vision workload. The mind stays blind until a host
// attaches a port, and the perception toggles decide whether this host does.
const castaliaStore = useCastaliaPluginStore()
const invokePsyche = useElectronEventaInvoke(castaliaMemoryPsyche)
const invokeSelfCycle = useElectronEventaInvoke(castaliaMemorySelfCycle)
/** The engine owns the affect state; the mirror refreshes on this cadence so the prompt is never stale. */
const PSYCHE_SYNC_INTERVAL_MS = 5 * 60_000
let psycheSyncTimer: ReturnType<typeof setInterval> | null = null
const perceptionStore = usePerceptionStore()
const screenSense = createScreenSense()
/** How often the idle mind glances at the screen. One look costs a capture plus one vision read. */
const LOOK_AROUND_INTERVAL_MS = 5 * 60_000
let lookAroundTimer: ReturnType<typeof setInterval> | null = null
// The desktop shell starts the same autonomy ticker as the web app. Without this
// line the policy layer runs (its tests pass) but nothing ever fires: she only
// answers, never opens a conversation on her own.
const selfInitiatedSpeechStore = useSelfInitiatedSpeechStore()
const builtinToolsStore = useTamagotchiBuiltinToolsStore()
const homeAssistantStore = useTamagotchiHomeAssistantStore()
const mcpToolsStore = useTamagotchiMcpToolsStore()
const pluginToolsStore = useTamagotchiPluginToolsStore()
const syncedPinia = usePiniaSynced()
const isSpotlightWindow = initialRoutePath === '/spotlight'
// The floating chat resizes from its own edges, which keep the edges beside the character in place.
const isFloatingChatWindow = initialRoutePath === '/chat-floating'
// The fullscreen mode places the main window itself, so its edges offer no resize.
const { active: mainWindowFullscreen } = storeToRefs(useFullscreenStore())
// A window that hosts the fullscreen mode can load on a settings route, after a reload for example. So the windows
// are told apart by the host that the main process names, not by the first route alone.
const isSettingsWindow = !windowContext.fullscreenHost && (initialRoutePath === '/settings' || initialRoutePath.startsWith('/settings/'))
// Every window sends its spans to the hub, so the IO tracer and the trace files have the spans of every window.
const stopIOTraceHubBridge = initializeIOTraceHubBridge(context.value)

async function refreshPluginRuntimeTools() {
  try {
    await pluginToolsStore.refresh()
  }
  catch (error) {
    console.warn('[App] Failed to refresh plugin runtime tools:', error)
  }
}

// Every renderer creates the runtime tool stores for synchronized state. Only
// the main Stage renderer discovers tools and keeps executors.
const stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
  if (!isLeader)
    return

  void builtinToolsStore.refresh().catch((error) => {
    console.warn('[App] Failed to refresh built-in runtime tools:', error)
  })
  void mcpToolsStore.refresh().catch((error) => {
    console.warn('[App] Failed to refresh MCP runtime tools:', error)
  })
  void homeAssistantStore.refresh().catch((error) => {
    console.warn('[App] Failed to refresh Home Assistant tools:', error)
  })
  void refreshPluginRuntimeTools()
})

function createFullStageRuntime() {
  const contextBridgeStore = useContextBridgeStore()
  const displayModelsStore = useDisplayModelsStore()
  const serverChannelSettingsStore = useServerChannelSettingsStore()
  const cardStore = useAiriCardStore()
  const serverChannelStore = useModsServerChannelStore()
  const characterOrchestratorStore = useCharacterOrchestratorStore()
  const inferencePreload = useInferencePreload()
  const pluginHostInspectorStore = usePluginHostInspectorStore()
  const stageWindowLifecycleStore = useStageWindowLifecycleStore()
  const settingsAudioDeviceStore = useSettingsAudioDevice()
  const artistryStore = useArtistryStore()
  useConsciousnessStore()
  useHearingStore()
  useSpeechStore()
  useSettingsStageModel()
  useVisionStore()

  const { activeProvider, artistryGlobals, activeModel, defaultPromptPrefix, providerOptions } = storeToRefs(artistryStore)
  const getServerChannelConfig = useElectronEventaInvoke(electronGetServerChannelConfig)
  const listPlugins = useElectronEventaInvoke(electronPluginList)
  const preparePluginDirectoryImport = useElectronEventaInvoke(electronPluginPrepareDirectoryImport)
  const commitPluginDirectoryImport = useElectronEventaInvoke(electronPluginCommitDirectoryImport)
  const cancelPluginDirectoryImport = useElectronEventaInvoke(electronPluginCancelDirectoryImport)
  const setPluginEnabled = useElectronEventaInvoke(electronPluginSetEnabled)
  const setPluginAutoReload = useElectronEventaInvoke(electronPluginSetAutoReload)
  const loadEnabledPlugins = useElectronEventaInvoke(electronPluginLoadEnabled)
  const loadPlugin = useElectronEventaInvoke(electronPluginLoad)
  const unloadPlugin = useElectronEventaInvoke(electronPluginUnload)
  const inspectPluginHost = useElectronEventaInvoke(electronPluginInspect)
  const reportPluginCapability = useElectronEventaInvoke(electronPluginUpdateCapability)
  const getGodotStageStatus = useElectronEventaInvoke(electronGodotStageGetStatus)
  const syncArtistryConfig = useElectronEventaInvoke(artistrySyncConfig)
  const usesGodotStage = !!windowContext.fullscreenHost || initialRoutePath.startsWith('/settings')
  const isWidgetsWindow = initialRoutePath === '/widgets'

  function syncGodotStageRenderer(state: { state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' }) {
    if (state.state === 'running') {
      settingsStore.setStageModelRenderer('godot')
      return
    }

    if ((state.state === 'stopped' || state.state === 'error') && settingsStore.stageModelRenderer === 'godot')
      settingsStore.restoreBuiltInStageModelRenderer()
  }

  usePerfTracerBridgeStore()
  initializeStageThreeRuntimeTraceBridge()
  void stageWindowLifecycleStore.initializeWindowLifecycleBridge()

  contextBridgeStore.setSparkNotifyHostRole(isWidgetsWindow ? 'client' : 'main')

  // NOTICE: register plugin host bridge during setup to avoid race with pages using it in immediate watchers.
  pluginHostInspectorStore.setBridge({
    prepareDirectoryImport: () => preparePluginDirectoryImport(),
    commitDirectoryImport: payload => commitPluginDirectoryImport(payload),
    cancelDirectoryImport: payload => cancelPluginDirectoryImport(payload),
    list: () => listPlugins(),
    setEnabled: async (payload) => {
      const result = await setPluginEnabled(payload)
      await refreshPluginRuntimeTools()
      return result
    },
    setAutoReload: payload => setPluginAutoReload(payload),
    loadEnabled: async () => {
      const result = await loadEnabledPlugins()
      await refreshPluginRuntimeTools()
      return result
    },
    load: async (payload) => {
      const result = await loadPlugin(payload)
      await refreshPluginRuntimeTools()
      return result
    },
    unload: async (payload) => {
      const result = await unloadPlugin(payload)
      await refreshPluginRuntimeTools()
      return result
    },
    inspect: () => inspectPluginHost(),
  })

  let lastSyncedArtistryConfig: ArtistrySyncPayload | undefined
  watch([activeProvider, artistryGlobals, activeModel, defaultPromptPrefix, providerOptions], () => {
    if (!activeProvider.value)
      return

    const config = JSON.parse(JSON.stringify({
      provider: activeProvider.value,
      globals: artistryGlobals.value,
      model: activeModel.value,
      promptPrefix: defaultPromptPrefix.value,
      options: providerOptions.value,
    })) as ArtistrySyncPayload
    if (isEqual(config, lastSyncedArtistryConfig))
      return

    // Pinia synchronization applies cloned snapshots in every renderer. Keep
    // this IPC bridge edge-triggered so equal snapshots do not repeat IO.
    lastSyncedArtistryConfig = config
    void syncArtistryConfig(config)
  }, { deep: true, immediate: true })

  context.value.on(electronGodotStageStatusChanged, (event) => {
    if (!event.body) {
      return
    }

    syncGodotStageRenderer(event.body)
  })

  context.value.on(electronPluginToolsChanged, () => {
    void refreshPluginRuntimeTools()
  })

  return {
    async initialize() {
      await displayModelsStore.initialize()
      await cardStore.initialize()

      await displayModelsStore.loadDisplayModelsFromIndexedDB()
      await settingsStore.initializeStageModel()
      await settingsAudioDeviceStore.initialize()

      if (usesGodotStage) {
        try {
          syncGodotStageRenderer(await getGodotStageStatus())
        }
        catch (error) {
          console.warn('[App] Failed to fetch Godot stage status:', error)
        }
      }

      const serverChannelConfig = await getServerChannelConfig()
      serverChannelSettingsStore.tlsConfig = serverChannelConfig.tlsConfig ?? null
      serverChannelSettingsStore.hostname = serverChannelConfig.hostname
      serverChannelSettingsStore.authToken = serverChannelConfig.authToken

      await serverChannelStore.initialize({
        token: serverChannelConfig.authToken || undefined,
        possibleEvents: ['ui:configure'],
      }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
      contextBridgeStore.initialize()
      if (!isWidgetsWindow) {
        characterOrchestratorStore.initialize(syncedPinia)
      }

      defineInvokeHandler(context.value, pluginProtocolListProviders, async () => listProvidersForPluginHost())

      if (shouldPublishPluginHostCapabilities()) {
        await reportPluginCapability({
          key: pluginProtocolListProvidersEventName,
          state: 'ready',
          metadata: {
            source: 'stage-ui',
          },
        })
      }

      inferencePreload.triggerPreload()
    },
    dispose() {
      characterOrchestratorStore.dispose()
      contextBridgeStore.dispose()
    },
  }
}

const fullStageRuntime = windowContext.stageRuntime === 'full'
  ? createFullStageRuntime()
  : null
// A minimal chat window shows the live reply of the turn that the main window runs.
// The full runtime starts the whole context bridge, which includes this view.
const chatStreamView = !fullStageRuntime && (initialRoutePath === '/chat' || isFloatingChatWindow)
  ? useContextBridgeStore()
  : null

const { restore: restoreLocale } = useLanguage(language, getMainLocale, setLocale)

const { updateThemeColor } = useThemeColor(themeColorFromValue({ light: 'rgb(255 255 255)', dark: 'rgb(18 18 18)' }))
watch(dark, () => updateThemeColor(), { immediate: true })
watch(route, () => updateThemeColor(), { immediate: true })
onMounted(() => updateThemeColor())

if (isSettingsWindow) {
  context.value.on(electronSettingsNavigate, (event) => {
    const targetRoute = event?.body?.route
    if (!targetRoute || route.fullPath === targetRoute) {
      return
    }

    void router.push(targetRoute).catch((error) => {
      console.warn('Failed to navigate settings window:', error)
    })
  })
}

onMounted(async () => {
  // The desktop is the only chat consumer, and input:text is dropped with "no consumer registered for event
  // delivery" when nobody claims the group. context-bridge registers inside createFullStageRuntime, which only
  // runs for stage-runtime=full windows; claiming it here covers every window and survives reconnects.
  // Only the full stage runtime answers chat: a minimal window registers too, and the group would hand it the
  // message instead of the window that owns the conversation.
  if (windowContext.stageRuntime !== 'minimal') {
    const chatChannel = useModsServerChannelStore()
    const claimChatIngestion = () => {
      for (const event of ['input:text', 'input:text:voice', 'input:voice']) {
        chatChannel.send({
          type: 'module:consumer:register',
          data: { event, mode: 'consumer-group', group: 'chat-ingestion', priority: 100 },
        } as never)
      }
    }
    void chatChannel.ensureConnected()
      .catch(error => console.error('[AIRI] consumer registration failed:', error))
    // Ready, not connected: `connected` flips at authenticate, while the SDK only accepts sends once announce
    // completes. A claim sent in the authenticate tick is refused by the transport and dropped without an error,
    // which is why the group looked unclaimed on every cold start.
    chatChannel.onReady(() => {
      claimChatIngestion()
      console.info('[AIRI] claimed chat-ingestion consumer group at priority 100')
    })
    // A window that mounts into an already-ready connection gets no ready callback, so claim once here.
    if (chatChannel.connected)
      claimChatIngestion()
  }

  void listModelAssets().then((statuses) => {
    for (const status of statuses) {
      if (!isSherpawModelBundled(status.id))
        updateModelAssetStatus(status)
    }
  }).catch(error => console.warn('Failed to read model asset status:', error))

  // NOTICE: Issue #1658
  // When Electron restarts, renderer localStorage may not be flushed to disk.
  // The store's onMounted hook falls back to navigator.language, which triggers
  // watch(language) and overwrites the main-process config with the OS locale.
  // We must restore the correct locale from main process before allowing sync.
  // https://github.com/moeru-ai/airi/issues/1658
  await restoreLocale()

  await chatStore.initialize(syncedPinia)

  // She can open a conversation on her own. The ticker reads Castalia's energy,
  // desire and arousal plus the relationship depth, and never fires while the
  // user is still inside the grace window. The web app starts the same ticker.
  selfInitiatedSpeechStore.start()

  // The mind reads what happened while the app was off, then keeps its own clock.
  // It only listens to finished turns; it never reads the chat store directly, so
  // the two stores stay independent.
  mindStore.attachTurnComplete(chatStore.onChatTurnComplete)
  await mindStore.initialize()

  // Her eyes are attached only while perception allows them, and the idle mind glances at the screen on a slow
  // timer. Without both, `lookAround` has nothing to see and the drive of curiosity never moves.
  watchEffect(() => {
    mindStore.attachSense(perceptionStore.screen && perceptionStore.screenReady ? screenSense : undefined)
  })
  lookAroundTimer = setInterval(() => {
    if (mindStore.senseAttached)
      void mindStore.lookAround()
  }, LOOK_AROUND_INTERVAL_MS)

  // Mirror the engine's psyche into her self-state. Without this the state line and the panel only move when the
  // model calls a tool, and she never does; the bank has the values all along.
  const syncPsyche = async () => {
    try {
      const psyche = await invokePsyche({})
      if (psyche?.hasEvidence)
        castaliaStore.syncPsyche({ vad: psyche.vad, at: psyche.updatedAt }, psyche.characterId)
    }
    catch { /* the mirror is best-effort; the engine keeps the truth */ }
  }
  void syncPsyche()
  psycheSyncTimer = setInterval(() => void syncPsyche(), PSYCHE_SYNC_INTERVAL_MS)

  // 无聊/好奇的时候真的去想一次：mind 的驱力走到 `think`，这里把它接到 Castalia 的自循环
  // （读最近的对话证据、写一篇带出处的日记）。日记正文回来后被内化成一句自言自语。
  // `minIntervalHours: 0` 把节奏交给 mind 的 20 分钟冷却 —— 引擎那道 15 分钟闸门只会让
  // 「她正好无聊」的时刻被无故跳过，而定时自循环（6 小时）仍由引擎自己管。
  mindStore.attachThink(async () => {
    try {
      const report = await invokeSelfCycle({ minIntervalHours: 0 })
      if (!report?.ok || report.skipped)
        return undefined
      return report.diaryText
    }
    catch {
      // 引擎没起来就当这次没想成；下一次 tick 还会再来。
      return undefined
    }
  })

  await fullStageRuntime?.initialize()
  await chatStreamView?.initializeStreamView()
})

watch(themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', themeColorsHue.value.toString())
}, { immediate: true })

watch(themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', themeColorsHueDynamic.value)
}, { immediate: true })

onUnmounted(() => {
  selfInitiatedSpeechStore.stop()
  if (lookAroundTimer)
    clearInterval(lookAroundTimer)
  lookAroundTimer = null
  if (psycheSyncTimer)
    clearInterval(psycheSyncTimer)
  psycheSyncTimer = null
  mindStore.attachSense(undefined)
  mindStore.attachThink(undefined)
  mindStore.dispose()
  stopIOTraceHubBridge()
  stopModelAssetStatus()
  stopLeadershipListener?.()
  chatStore.dispose()
  fullStageRuntime?.dispose()
  void chatStreamView?.dispose()
})
</script>

<template>
  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>
  <ResizeHandler v-if="!isSpotlightWindow && !isFloatingChatWindow && !mainWindowFullscreen" />
  <RouterView />
</template>

<style>
/* We need this to properly animate the CSS variable */
@property --chromatic-hue {
  syntax: '<number>';
  initial-value: 0;
  inherits: true;
}

@keyframes hue-anim {
  from {
    --chromatic-hue: 0;
  }
  to {
    --chromatic-hue: 360;
  }
}

.dynamic-hue {
  animation: hue-anim 10s linear infinite;
}
</style>
