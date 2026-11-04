<script setup lang="ts">
import type { ArtistrySyncPayload } from '@proj-airi/stage-shared'

import { defineInvokeHandler } from '@moeru/eventa'
import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { artistrySyncConfig } from '@proj-airi/stage-shared'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { updateModelAssetStatus, useInferencePreload } from '@proj-airi/stage-ui/composables'
import { usePiniaSynced } from '@proj-airi/stage-ui/libs/pinia'
import { isSherpawModelBundled, setSherpawModelAssetHost } from '@proj-airi/stage-ui/libs/providers/providers/sherpaw/model-assets'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
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
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useRemoteStageStore } from '@proj-airi/stage-ui/stores/remote-stage'
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
import { castaliaMemoryFacts, castaliaMemoryForget, castaliaMemoryIngest, castaliaMemoryList, castaliaMemoryMaintain, castaliaMemoryPsyche, castaliaMemoryRecall, castaliaMemorySave, castaliaMemorySearch, castaliaMemorySelfCycle, castaliaMemorySetEnabled, castaliaMemorySetEnergy, castaliaMemoryStatus } from '../shared/eventa/castalia-memory'
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
import { createScreenSense } from './libs/screen-sense'
import { useFullscreenStore } from './stores/fullscreen'
import { useServerChannelSettingsStore } from './stores/settings/server-channel'
import { useStageWindowLifecycleStore } from './stores/stage-window-lifecycle'
import {
  useTamagotchiBuiltinToolsStore,
  useTamagotchiHomeAssistantStore,
  useTamagotchiMcpToolsStore,
  useTamagotchiPluginToolsStore,
  useTamagotchiVideoToolsStore,
} from './stores/tools'
import { useVideoAutonomyStore } from './stores/video-autonomy'
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
const searchCastaliaMemory = useElectronEventaInvoke(castaliaMemorySearch)
const factsCastaliaMemory = useElectronEventaInvoke(castaliaMemoryFacts)
const ingestCastaliaMemory = useElectronEventaInvoke(castaliaMemoryIngest)
const statusCastaliaMemory = useElectronEventaInvoke(castaliaMemoryStatus)
// 主进程自己排的定时器不认识面板开关，把状态推过去，关掉就真的停（审计 A06）。
const setCastaliaEnabled = useElectronEventaInvoke(castaliaMemorySetEnabled)
memoryStore.attachRemote({
  list: listCastaliaMemory,
  save: saveCastaliaMemory,
  // The backend answers whether the row is really gone; dropping that answer made the list a liar
  // (the entry reappeared on the next hydrate).
  forget: entry => forgetCastaliaMemory(entry),
  // 每一路都带上当前卡的 persona：不带时后端只认配置里的角色，第二张卡的内存会串到一起（审计 F01）。
  recall: (query, persona) => recallCastaliaMemory({ query, persona }),
  // 模型主动查记忆的检索通道：让她真的能"翻记忆体"，而不是只能按索引名逐条读。
  search: (query, topK, persona) => searchCastaliaMemory({ query, topK, persona }),
  // 同一句查询顺带取结构化事实：一行事实常是记忆行只隐含的答案（她是谁、小托是谁）。
  facts: (query, topK, persona) => factsCastaliaMemory({ query, topK, persona }),
  // 每轮对话的写回入口：没有它，她只说、不记。
  ingest: turn => ingestCastaliaMemory(turn),
})
void memoryStore.hydrate()
// 「模块开着」和「后端真的能检索/入库」是两件事：界面要能回答后者（审计 F05）。
void statusCastaliaMemory()
  .then(status => memoryStore.setBackend(status))
  .catch(error => memoryStore.setBackend({
    transport: 'none',
    capabilities: { vadSweep: false, recall: false, search: false, facts: false, ingest: false, maintain: false, selfCycle: false, psyche: false },
    error: `后端状态查询失败：${(error as Error)?.message ?? error}`,
    checkedAt: Date.now(),
  }))
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
// The card store is module-scope here on purpose: the card watcher below runs in this scope, and
// reaching for the one inside `createFullStageRuntime()` was a ReferenceError at startup.
const airiCards = useAiriCardStore()
// Her eyes: the screen, summarised to one line per look by the vision workload. The mind stays blind until a host
// attaches a port, and the perception toggles decide whether this host does.
const castaliaStore = useCastaliaPluginStore()
const invokePsyche = useElectronEventaInvoke(castaliaMemoryPsyche)
const invokeSelfCycle = useElectronEventaInvoke(castaliaMemorySelfCycle)
const invokeSetEnergy = useElectronEventaInvoke(castaliaMemorySetEnergy)
const invokeMaintain = useElectronEventaInvoke(castaliaMemoryMaintain)
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
const videoToolsStore = useTamagotchiVideoToolsStore()
// The autonomy ticker starts itself when the video module turns `autonomous` on; instantiating the
// store here is what binds that timer to the app's lifetime.
useVideoAutonomyStore()
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
  // The video module keeps its tools mounted across leadership changes; a renderer that only
  // joins later still needs them, so the leader re-mounts them here.
  void videoToolsStore.refresh().catch((error) => {
    console.warn('[App] Failed to refresh video tools:', error)
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
  const remoteStageStore = useRemoteStageStore()
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
      // The registry of stage peers decides whether this machine keeps its own voice.
      remoteStageStore.start()
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

  // Auto-run recipes: the loop asks which schedule is due once a minute and starts it through the same
  // background-run path as a recipe the model picks, so nothing here decides what a run does.
  chatStore.startAutoRun()

  // The mind reads what happened while the app was off, then keeps its own clock.
  // It only listens to finished turns; it never reads the chat store directly, so
  // the two stores stay independent.
  mindStore.attachTurnComplete(chatStore.onChatTurnComplete)

  // One resolver for every path: the chat maps `default` to `airi`, so the panel, the mind, and the
  // engine mirror must ask the same question or they read two different self-states (audit F11).
  const resolvedPersona = () => memoryStore.enabled
    ? memoryStore.resolvePersona(airiCards.activeCardId)
    : airiCards.activeCardId

  await mindStore.initialize(resolvedPersona())

  // Switching cards switches the mind: drives, sleep, and the diary stream belong to one character, so the
  // outgoing character's state is saved under her own key and the new one resumes from her own.
  watch(() => airiCards.activeCardId, () => {
    void mindStore.switchCharacter(resolvedPersona())
  })

  // Her eyes are attached only while perception allows them, and the idle mind glances at the screen on a slow
  // timer. Without both, `lookAround` has nothing to see and the drive of curiosity never moves.
  watchEffect(() => {
    mindStore.attachSense(perceptionStore.screen && perceptionStore.screenReady ? screenSense : undefined)
  })
  lookAroundTimer = setInterval(() => {
    // 睡着/打盹时别抓屏：既没有意义，也会把她弄醒。
    if (mindStore.isOwner && mindStore.senseAttached && !mindStore.asleep && !mindStore.napping)
      void mindStore.lookAround()
  }, LOOK_AROUND_INTERVAL_MS)

  // Mirror the engine's psyche into her self-state. Without this the state line and the panel only move when the
  // model calls a tool, and she never does; the bank has the values all along.
  const syncPsyche = async () => {
    // The module switch has to gate the loop it names: a "closed" Castalia that keeps polling and
    // writing is the switch lying about its scope (audit F14).
    if (!castaliaStore.enabled)
      return
    try {
      const psyche = await invokePsyche({ characterId: resolvedPersona() })
      if (psyche?.hasEvidence)
        castaliaStore.syncPsyche({ vad: psyche.vad, mood: psyche.mood, band: psyche.band, at: psyche.updatedAt }, psyche.characterId)
    }
    catch { /* the mirror is best-effort; the engine keeps the truth */ }
  }
  void syncPsyche()
  // The backend report describes a running process, so it is re-read on the same slow clock: a
  // module switched on after start shows what it really got, without waiting for a restart.
  const pushModuleSwitches = () => {
    void setCastaliaEnabled({ memory: memoryStore.enabled, castalia: castaliaStore.enabled }).catch(() => {})
  }
  pushModuleSwitches()
  watch([() => memoryStore.enabled, () => castaliaStore.enabled], pushModuleSwitches, { immediate: false })

  const refreshBackend = () => {
    void statusCastaliaMemory()
      .then(status => memoryStore.setBackend(status))
      .catch(() => {})
    // 主进程的维护/自循环会自己往库里写行，渲染层不知道；跟着这个慢钟重读一次，
    // 「维护完成但 read 看不到」就不会拖到重启（审计 A09）。
    memoryStore.scheduleRefresh(0)
  }
  refreshBackend()
  psycheSyncTimer = setInterval(() => {
    refreshBackend()
    void syncPsyche()
  }, PSYCHE_SYNC_INTERVAL_MS)

  // 无聊/好奇的时候真的去想一次：mind 的驱力走到 `think`，这里把它接到 Castalia 的自循环
  // （读最近的对话证据、写一篇带出处的日记）。日记正文回来后被内化成一句自言自语。
  // `minIntervalHours: 0` 把节奏交给 mind 的 20 分钟冷却 —— 引擎那道 15 分钟闸门只会让
  // 「她正好无聊」的时刻被无故跳过，而定时自循环（6 小时）仍由引擎自己管。
  mindStore.attachThink(async () => {
    if (!castaliaStore.enabled)
      return undefined
    try {
      const report = await invokeSelfCycle({ minIntervalHours: 0, energy: 100 - mindStore.drives.fatigue, characterId: resolvedPersona() })
      if (!report?.ok || report.skipped)
        return undefined
      // The diary is a new row the local cache never saw; re-read so `read` and the index know it (F09).
      memoryStore.scheduleRefresh()
      return report.diaryText
    }
    catch {
      // 引擎没起来就当这次没想成；下一次 tick 还会再来。
      return undefined
    }
  })

  // 累了就睡：mind 的疲劳走到阈值，这一觉接的是 Castalia 的维护（reflect → consolidate → digest）。
  // 报告决定睡得多沉——三段都成按满速恢复；失败就睡得更久，而不是"躺够时长就满血"。
  // 走同一个 maintain 入口，主进程那份落账会挡住 04:00 的第二次整理。
  // 一个数：mind 的疲劳决定她的精力，面板和提示词只镜像这一份。
  // 之前 castalia 自己按墙钟衰减、又被 syncPsyche 每 5 分钟抹平，才会出现「面板 100、心里累垮」。
  watch(
    () => mindStore.drives.fatigue,
    (fatigue) => {
      // A second window would push the same fatigue into the engine and fight
      // the owner's numbers; only the lease holder mirrors energy.
      if (!mindStore.isOwner || !castaliaStore.enabled)
        return
      castaliaStore.setEnergy(100 - fatigue, resolvedPersona())
      // The engine builds the six-hour diary itself; give it the same number so
      // its prompt cannot say 98/100 while the chat says she is running empty.
      void invokeSetEnergy({ value: 100 - fatigue, persona: resolvedPersona() }).catch(() => {})
    },
    { immediate: true },
  )

  mindStore.attachSleep(async () => {
    // Nothing to maintain while the module is off; the night becomes a plain sleep rather than a
    // maintenance that reports success without running (F14).
    if (!castaliaStore.enabled) {
      console.info('[castalia] maintain skipped: module is off')
      return undefined
    }
    try {
      const report = await invokeMaintain({ limit: 30 })
      // Maintenance writes facts and digests of its own; they become readable without a restart (F09).
      if (report?.ok && !report.skipped)
        memoryStore.scheduleRefresh()
      const reflect = report?.reflect as { ok?: boolean } | undefined
      const consolidate = report?.consolidate as { ok?: boolean } | undefined
      const digest = report?.digest as { success?: boolean } | undefined
      return {
        reflectOk: Boolean(reflect?.ok),
        consolidateOk: Boolean(consolidate?.ok),
        digestOk: Boolean(digest?.success),
      }
    }
    catch {
      // 维护失败不等于不能睡：返 undefined，mind 会按 0.5 的恢复率继续这一觉。
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
  chatStore.stopAutoRun()
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
