import type {} from 'pinia-plugin-synced'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { useProviderStore } from '../providers/provider'
import { useConsciousnessSettingsStore } from './consciousness-settings'

/** 一套采样参数。和 `temperature`/`topP` 是同一份真源，只是按模型家族分册存。 */
export interface ModelParamPreset {
  temperature: number
  topP: number
  temperatureEnabled: boolean
  topPEnabled: boolean
}

/** 一个模型名下的那一份。键是 model id，`default` 是该家族的起点。 */
export type ParamPresetBook = Record<string, ModelParamPreset>
/** 预设家族 → 该家族下每个模型各自的一份。 */
export type ParamPresetBooks = Record<string, ParamPresetBook>

export interface ModelParamPresetDefinition {
  id: string
  label: string
  /** 命中条件：provider id 或 model id 里出现任意一个片段。 */
  match: readonly string[]
}

/**
 * 哪些模型家族各有一套。
 *
 * 按 model id 也匹配，因为同一条模型可以挂在不同的 provider 下（自建中转、
 * 火山方舟都会把 `deepseek-*` / `minimax-*` 放在自己的 id 里）。
 */
export const MODEL_PARAM_PRESETS: readonly ModelParamPresetDefinition[] = [
  { id: 'deepseek', label: 'DeepSeek', match: ['deepseek'] },
  { id: 'minimax', label: 'MiniMax', match: ['minimax'] },
]

/**
 * 两套起点值。
 *
 * 依据厂商文档，不用主观数：DeepSeek 的 temperature 默认为 1.0，官方给「通用对话」
 * 的场景值是 1.3；MiniMax M2 官方推荐 `temperature=1.0`、`top_p=0.95`。
 *
 * DeepSeek 这套收到 0.8：它是一版 flash 级模型，指令漂移比温度带来的语气损失更显眼，
 * 但再往下压会把语气压平——**低温度反而让「你在忙吗」这类高频套话更容易出现**，而且
 * 那条指令真正靠的是门和提示词，不是采样。MiniMax 这套保持厂商值。
 */
export const MODEL_PARAM_PRESET_DEFAULTS: Record<string, ModelParamPreset> = {
  deepseek: { temperature: 0.8, topP: 0.9, temperatureEnabled: true, topPEnabled: true },
  minimax: { temperature: 1.0, topP: 0.95, temperatureEnabled: true, topPEnabled: true },
}

/** 没给某个模型单独存值时用的键。它同时承接旧版按家族存的扁平结构。 */
const PRESET_DEFAULT_MODEL = 'default'
const PARAM_PRESETS_BY_MODEL_KEY = 'settings/consciousness/param-presets-by-model'
/** 旧版的存储键：一族一份扁平值，没有模型维度。迁移后删除。 */
const LEGACY_PARAM_PRESETS_KEY = 'settings/consciousness/param-presets'

function readParamPreset(value: unknown): ModelParamPreset | undefined {
  if (!value || typeof value !== 'object')
    return undefined
  const record = value as Record<string, unknown>
  const temperature = Number(record.temperature)
  const topP = Number(record.topP)
  if (!Number.isFinite(temperature) || !Number.isFinite(topP))
    return undefined
  return {
    temperature,
    topP,
    // 只有显式写了 `false` 才算关掉：旧记录只搬数字时，缺省的开关按「启用」处理。
    temperatureEnabled: record.temperatureEnabled !== false,
    topPEnabled: record.topPEnabled !== false,
  }
}

/** 每个家族的起点，包成「一族一本书」。 */
export function seedParamPresetBooks(): ParamPresetBooks {
  const books: ParamPresetBooks = {}
  for (const [id, values] of Object.entries(MODEL_PARAM_PRESET_DEFAULTS))
    books[id] = { [PRESET_DEFAULT_MODEL]: { ...values } }
  return books
}

/**
 * 旧版扁平结构 → 两级结构，只做一次。
 *
 * 不迁移的话，用户调好的那套值会被当作「没有记录」，切一次模型就静默回到起点。
 * 写完新键就删旧键：留着两份真源，下一次只会更难判断哪份在生效。
 */
function migrateLegacyParamPresets(): ParamPresetBooks | undefined {
  if (typeof localStorage === 'undefined')
    return undefined
  if (localStorage.getItem(PARAM_PRESETS_BY_MODEL_KEY))
    return undefined
  const raw = localStorage.getItem(LEGACY_PARAM_PRESETS_KEY)
  if (!raw)
    return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object')
    return undefined
  const books: ParamPresetBooks = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const preset = readParamPreset(value)
    if (preset)
      books[id] = { [PRESET_DEFAULT_MODEL]: preset }
  }
  if (!Object.keys(books).length)
    return undefined
  localStorage.setItem(PARAM_PRESETS_BY_MODEL_KEY, JSON.stringify(books))
  localStorage.removeItem(LEGACY_PARAM_PRESETS_KEY)
  return books
}

export const useConsciousnessStore = defineStore('consciousness', () => {
  const providersStore = useProviderStore()
  const settingsStore = useConsciousnessSettingsStore()

  // Pinia synchronization owns live cross-window state. localStorage remains
  // durable persistence, but storage events must not reflect state back into
  // the store and publish another synchronized snapshot.
  const persistenceOptions = { listenToStorageChanges: false }

  // State
  const activeProvider = useLocalStorageManualReset<string>('settings/consciousness/active-provider', '', persistenceOptions)
  const activeModel = useLocalStorageManualReset<string>('settings/consciousness/active-model', '', persistenceOptions)
  const activeCustomModelName = useLocalStorageManualReset<string>('settings/consciousness/active-custom-model', '', persistenceOptions)
  const expandedDescriptions = refManualReset<Record<string, boolean>>(() => ({}))
  const modelSearchQuery = refManualReset<string>('')

  // Computed properties
  const supportsModelListing = computed(() => {
    return providersStore.supportsModelListing(activeProvider.value)
  })

  const providerModels = computed(() => {
    return providersStore.getModelsForProvider(activeProvider.value)
  })

  function isOpenRouterProvider(provider: string) {
    return providersStore.findProviderDefinition(provider)?.id === 'openrouter-ai'
  }

  const activeModelRequiresReasoning = computed(() => {
    return isOpenRouterProvider(activeProvider.value)
      && providerModels.value.find(model => model.id === activeModel.value)?.reasoning?.mandatory === true
  })

  const activeModelUsesProviderReasoningDefault = computed(() => {
    return isOpenRouterProvider(activeProvider.value)
      && !providerModels.value.some(model => model.id === activeModel.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    return providersStore.isLoadingModels[activeProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    return providersStore.modelLoadError[activeProvider.value] || null
  })

  const temperature = useLocalStorageManualReset<number>(
    'settings/consciousness/active-temperature',
    0.7,
    persistenceOptions,
  )

  const topP = useLocalStorageManualReset<number>(
    'settings/consciousness/active-top-p',
    1.0,
    persistenceOptions,
  )

  /**
   * 采样参数按「家族 → 模型」两级存：家族让两个品牌各用各的，模型让手调过的值
   * 切走再切回来还在（只按家族存时会被覆盖）。`default` 是家族起点，也承接旧版
   * 扁平结构；面板的「存进这套」写到当前模型名下。
   */
  const paramPresetBooks = useLocalStorageManualReset<ParamPresetBooks>(
    PARAM_PRESETS_BY_MODEL_KEY,
    migrateLegacyParamPresets() ?? seedParamPresetBooks(),
    persistenceOptions,
  )
  /** 最近一次套用预设的时间。面板用它显示「真的接入了」，而不是只画两个数字。 */
  const paramPresetAppliedAt = refManualReset<number | undefined>(() => undefined)

  // Saved slider values do not imply consent to override provider defaults.
  // All request paths consume these projections; disabled fields stay undefined.
  const activeTemperature = computed(() => settingsStore.temperatureEnabled ? temperature.value : undefined)
  const activeTopP = computed(() => settingsStore.topPEnabled ? topP.value : undefined)

  /**
   * 当前模型属于哪一套预设。
   *
   * 先看 provider，再看 model：同一条模型可以挂在不同的 provider 下。两边都不匹配
   * 就是没有预设（面板显示「没有匹配」），而不是悄悄套一套别人的值。
   */
  const activeParamPreset = computed<ModelParamPresetDefinition | undefined>(() => {
    const target = `${activeProvider.value} ${activeModel.value}`.trim().toLowerCase()
    if (!target)
      return undefined
    return MODEL_PARAM_PRESETS.find(preset => preset.match.some(token => target.includes(token)))
  })

  /** 某个模型在该家族生效的值，以及它来自模型本身还是家族起点。`scope` 要显示给用户看。 */
  function paramPresetFor(presetId: string, modelId: string): { values: ModelParamPreset, scope: 'model' | 'default' } {
    const book = paramPresetBooks.value[presetId]
    const own = modelId ? readParamPreset(book?.[modelId]) : undefined
    if (own)
      return { values: own, scope: 'model' }
    return {
      values: readParamPreset(book?.[PRESET_DEFAULT_MODEL]) ?? MODEL_PARAM_PRESET_DEFAULTS[presetId]!,
      scope: 'default',
    }
  }

  /** 当前预设存着的值。没匹配就是 undefined。 */
  const activeParamPresetValues = computed<ModelParamPreset | undefined>(() => {
    const preset = activeParamPreset.value
    if (!preset)
      return undefined
    return paramPresetFor(preset.id, activeModel.value).values
  })

  /** 当前生效值属于「这个模型」还是「家族起点」。面板据此说明会存到哪里。 */
  const activeParamPresetScope = computed<'model' | 'default' | undefined>(() => {
    const preset = activeParamPreset.value
    if (!preset)
      return undefined
    return paramPresetFor(preset.id, activeModel.value).scope
  })

  /**
   * 把一套值写进真正的请求参数。
   *
   * 这里不另存一份「生效值」：`temperature`/`topP` 与两个开关就是请求读的那一份，
   * 面板显示的「请求实际带上」也读 `activeTemperature`/`activeTopP`。任何第二份
   * 真源都会让「面板看着改了、请求没变」重新出现。
   */
  function applyParamPreset(id: string) {
    const { values } = paramPresetFor(id, activeModel.value)
    temperature.value = Number(values.temperature)
    topP.value = Number(values.topP)
    void settingsStore.setTemperatureEnabled(Boolean(values.temperatureEnabled))
    void settingsStore.setTopPEnabled(Boolean(values.topPEnabled))
    paramPresetAppliedAt.value = Date.now()
  }

  function applyActiveParamPreset() {
    const preset = activeParamPreset.value
    if (preset)
      applyParamPreset(preset.id)
  }

  /**
   * 把滑杆上现在的值存到「这套 + 当前模型」名下。
   *
   * 没选模型时写家族起点（`default`），这样面板不会因为「不知道存给谁」而静默丢弃。
   */
  function saveParamPresetFromCurrent(id: string) {
    const modelId = activeModel.value.trim() || PRESET_DEFAULT_MODEL
    const book: ParamPresetBook = { ...(paramPresetBooks.value[id] ?? {}) }
    book[modelId] = {
      temperature: temperature.value,
      topP: topP.value,
      temperatureEnabled: settingsStore.temperatureEnabled,
      topPEnabled: settingsStore.topPEnabled,
    }
    paramPresetBooks.value = { ...paramPresetBooks.value, [id]: book }
    paramPresetAppliedAt.value = Date.now()
  }

  // 切模型就是换脑子：参数跟着模型走，不跟人走。`post` 是为了让 provider 变化时
  // 那个「先清空 model」的同步 watch 先跑完，再按最终的 provider + model 匹配。
  watch([activeProvider, activeModel], () => applyActiveParamPreset(), { immediate: true, flush: 'post' })

  // 用户手动关掉某个开关时，把它写进当前模型的记录。否则下次套用（包括启动时那次）
  // 会按书里的 `true` 重新打开——「我关掉了，重启又开了」。
  watch(
    [() => settingsStore.temperatureEnabled, () => settingsStore.topPEnabled],
    () => {
      const preset = activeParamPreset.value
      if (preset)
        saveParamPresetFromCurrent(preset.id)
    },
  )

  const filteredModels = computed(() => {
    if (!modelSearchQuery.value.trim()) {
      return providerModels.value
    }

    const query = modelSearchQuery.value.toLowerCase().trim()
    return providerModels.value.filter(model =>
      model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
      || (model.description && model.description.toLowerCase().includes(query)),
    )
  })

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    expandedDescriptions.reset()
    modelSearchQuery.reset()
  }

  // A model id belongs to the catalog of the provider it was picked from, so
  // clear the selection whenever the provider changes. This used to live only
  // in the consciousness settings page, so provider changes made elsewhere
  // (onboarding, character cards, provider deletion) kept the previous
  // provider's model and chat requests failed upstream with model_not_found.
  //
  // The watcher is synchronous on purpose: call sites assign the provider
  // first and a new model right after, so a
  // deferred reset would wipe the model they just chose. Synchronous flush
  // makes "set provider, then set model" a safe, ordered operation.
  //
  // Issue #1761: https://github.com/moeru-ai/airi/issues/1761
  watch(activeProvider, (provider, oldProvider) => {
    if (provider === oldProvider)
      return

    activeModel.value = ''
    activeCustomModelName.value = ''
  }, { flush: 'sync' })

  async function loadModelsForProvider(provider: string) {
    if (providersStore.supportsModelListing(provider)) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (providersStore.supportsModelListing(provider)) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  /** Resolves a provider with the reasoning mode shared by every Consciousness input path. */
  async function getChatProviderInstance(provider: string) {
    const selectedModel = providerModels.value.find(model => model.id === activeModel.value)
    const useProviderReasoningDefault = provider === activeProvider.value
      && isOpenRouterProvider(provider)
      && (activeModelUsesProviderReasoningDefault.value || selectedModel?.reasoning?.mandatory === true)

    // OpenRouter applies the model default when reasoning is mandatory or unknown.
    if (useProviderReasoningDefault) {
      return providersStore.getChatProviderInstance(provider)
    }

    return providersStore.getChatProviderInstance(provider, {
      reasoning: settingsStore.reasoning ? 'enabled' : 'disabled',
    })
  }

  const configured = computed(() => {
    return !!activeProvider.value && !!activeModel.value
  })

  /** Whether chat can send. The `prompt-api` provider runs without a selected model. */
  const chatReady = computed(() => {
    return !!activeProvider.value && (!!activeModel.value || activeProvider.value === 'prompt-api')
  })

  async function resetState() {
    activeProvider.reset()
    resetModelSelection()
    temperature.reset()
    topP.reset()
    // 回到家族起点，并把旧键一并清掉：留着旧键，下一次启动的迁移会把它又搬回来。
    paramPresetBooks.value = seedParamPresetBooks()
    if (typeof localStorage !== 'undefined')
      localStorage.removeItem(LEGACY_PARAM_PRESETS_KEY)
    paramPresetAppliedAt.reset()
    await settingsStore.setTemperatureEnabled(false)
    await settingsStore.setTopPEnabled(false)
  }

  return {
    // State
    configured,
    chatReady,
    activeProvider,
    activeModel,
    activeTemperature,
    activeTopP,
    temperature,
    topP,
    paramPresetBooks,
    paramPresetFor,
    paramPresetAppliedAt,
    activeParamPreset,
    activeParamPresetValues,
    activeParamPresetScope,
    customModelName: activeCustomModelName,
    expandedDescriptions,
    modelSearchQuery,

    // Computed
    supportsModelListing,
    providerModels,
    activeModelRequiresReasoning,
    activeModelUsesProviderReasoningDefault,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    filteredModels,

    // Actions
    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    getChatProviderInstance,
    applyParamPreset,
    applyActiveParamPreset,
    saveParamPresetFromCurrent,
    resetState,
  }
}, {
  synced: {
    state: true,
  },
})
