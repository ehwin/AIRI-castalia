import type { Card, ccv3 } from '@proj-airi/ccc'
import type {
  Live2DExpressionControl,
  Live2DModelControls,
  Live2DMotionControl,
} from '@proj-airi/stage-ui-live2d/controls/manifest'
import type { Live2DControlPolicy } from '@proj-airi/stage-ui-live2d/types/avatar-model'

import type { CardModuleDefaults } from '../../services/airi-card-modules'
import type { AiriCard, AiriExtension } from '../../types/airiCard'
import type { CharacterAvatarModelReference } from '../../types/avatar-model'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { inspectLive2DModelControls } from '@proj-airi/stage-ui-live2d/controls/manifest'
import { isLive2DControlEnabled } from '@proj-airi/stage-ui-live2d/controls/policy'
import { StorageSerializers } from '@vueuse/core'
import { isEqual } from 'es-toolkit'
import { nanoid } from 'nanoid'
import { defineStore, getActivePinia } from 'pinia'
import { array, parse } from 'valibot'
import { computed, getCurrentScope, shallowRef, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT } from '../../constants/prompts/character-defaults'
import { formatLive2DActPrompt } from '../../constants/prompts/live2d-act'
import { wakeWordSchema } from '../../libs/voice/wake-words'
import { resolveModuleSelection } from '../../services/airi-card-modules'
import { createAvatarModelReference } from '../../services/avatar-model'
import { useDisplayModelsStore } from '../display-models'
import { useProviderStore } from '../providers/provider'
import { useSettingsStageModel } from '../settings/stage-model'
import { useArtistryStore } from './artistry'
import { useConsciousnessStore } from './consciousness'
import { useSpeechStore } from './speech'
import { useVisionStore } from './vision'

export type { AiriCard, AiriExtension } from '../../types/airiCard'

/** Every device can load this Display Model, because it is bundled and not stored. */
const BUILT_IN_DISPLAY_MODEL_ID = 'preset-live2d-1'
/** Global Stage model choice that versions before PR #2458 stored outside any card. */
const LEGACY_STAGE_MODEL_STORAGE_KEY = 'settings/stage/model'
/** The selected Character outlives a restart. The card map does not own it. */
const ACTIVE_CARD_ID_STORAGE_KEY = 'airi-card-active-id'
const emptyAvatarModels: readonly CharacterAvatarModelReference[] = Object.freeze([])
const emptyLive2DExpressions: readonly Live2DExpressionControl[] = Object.freeze([])
const emptyLive2DMotions: readonly Live2DMotionControl[] = Object.freeze([])
const emptyLive2DModelControls: Live2DModelControls = { expressions: [], motions: [] }

/**
 * Returns the Display Model ID that a card stored before Avatar Models existed.
 *
 * Use it before `newAiriCard` normalizes the card, because normalization deletes
 * the old `modules.displayModelId` field.
 */
function legacyDisplayModelIdOf(card: AiriCard): string | undefined {
  const extension = card.extensions?.airi
  if (!extension?.modules || extension.avatarModels?.length)
    return undefined

  const value: unknown = Reflect.get(extension.modules, 'displayModelId')
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resolveSystemPrompt(
  card: AiriCard | undefined,
  expressions: readonly Live2DExpressionControl[],
  motions: readonly Live2DMotionControl[],
): string {
  if (!card)
    return ''

  // Position-sensitive CCv3 fields are deliberately excluded until provider
  // message assembly owns their ordering and role semantics.
  const systemPromptParts = [
    card.systemPrompt,
    card.description,
    card.personality,
    card.scenario,
    card.extensions.airi.modules.artistry?.widgetInstruction,
    formatLive2DActPrompt(expressions, motions),
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)

  return systemPromptParts.join('\n\n')
}

function readPersistedActiveCardId(): string {
  try {
    return globalThis.localStorage?.getItem(ACTIVE_CARD_ID_STORAGE_KEY) || 'default'
  }
  catch {
    return 'default'
  }
}

function persistActiveCardId(id: string): boolean {
  try {
    globalThis.localStorage?.setItem(ACTIVE_CARD_ID_STORAGE_KEY, id)
    return true
  }
  catch {
    return false
  }
}

function clearPersistedActiveCardId(): boolean {
  try {
    globalThis.localStorage?.removeItem(ACTIVE_CARD_ID_STORAGE_KEY)
    return true
  }
  catch {
    return false
  }
}

export const useAiriCardStore = defineStore('airi-card', () => {
  // A watcher or an await runs outside the setup of this store. The active
  // Pinia can then be another one, so keep the Pinia that owns this store.
  const pinia = getActivePinia()
  const { t } = useI18n()
  const displayModels = useDisplayModelsStore()

  // Character configuration is durable. The selection is durable too, so a
  // restart opens the Character that the user picked.
  const cards = useLocalStorageManualReset<Map<string, AiriCard>>('airi-cards', new Map(), { listenToStorageChanges: false })
  const activeCardId = shallowRef(readPersistedActiveCardId())
  // The active Avatar Model is runtime state. Pinia replicates it between
  // windows, but the Character configuration remains its only durable owner.
  const selectedAvatarModelId = shallowRef<string>()
  const activeLive2DModelControls = shallowRef<Live2DModelControls>(emptyLive2DModelControls)
  let live2DControlLoadGeneration = 0
  let initialized = false
  /** True after `initialize` applied the active card. Before that, no card owns the Stage. */
  const ready = shallowRef(false)

  // Only leader-owned commands change defaults or apply card overrides. Runtime
  // module stores contain the effective selections, not another source of defaults.
  // Existing installations seed this snapshot once from their current settings.
  const moduleDefaults = useLocalStorageManualReset<CardModuleDefaults | null>('airi-card-module-defaults', null, {
    listenToStorageChanges: false,
    serializer: StorageSerializers.object,
  })
  let appliedModules: AiriExtension['modules'] | undefined
  let followingInheritedSettings = false
  const storeScope = getCurrentScope()

  const activeCard = computed(() => cards.value.get(activeCardId.value))
  const activeAvatarModels = computed(() => activeCard.value?.extensions.airi.avatarModels ?? emptyAvatarModels)
  const selectedAvatarModel = computed(() => activeAvatarModels.value.find(model => model.id === selectedAvatarModelId.value))
  const enabledLive2DExpressions = computed<readonly Live2DExpressionControl[]>(() => {
    const avatarModel = selectedAvatarModel.value
    if (avatarModel?.type !== 'live2d')
      return emptyLive2DExpressions

    return activeLive2DModelControls.value.expressions.filter(expression => isLive2DControlEnabled(
      avatarModel.config.controls,
      { kind: 'expression', id: expression.name },
    ))
  })
  const enabledLive2DMotions = computed<readonly Live2DMotionControl[]>(() => {
    const avatarModel = selectedAvatarModel.value
    if (avatarModel?.type !== 'live2d')
      return emptyLive2DMotions

    return activeLive2DModelControls.value.motions.filter(motion => isLive2DControlEnabled(
      avatarModel.config.controls,
      { kind: 'motion', id: motion.fileName },
    ))
  })

  function resolveDefaultAvatarModelId(card = activeCard.value) {
    const defaultAvatarModelId = card?.extensions.airi.defaultAvatarModelId
    if (!defaultAvatarModelId)
      return

    return card.extensions.airi.avatarModels.some(model => model.id === defaultAvatarModelId)
      ? defaultAvatarModelId
      : undefined
  }

  function useRuntimeModuleStores() {
    return {
      artistry: useArtistryStore(),
      consciousness: useConsciousnessStore(),
      speech: useSpeechStore(),
      vision: useVisionStore(),
    }
  }

  function readRuntimeModules(): CardModuleDefaults {
    const { consciousness, vision, speech } = useRuntimeModuleStores()
    return {
      consciousness: { provider: consciousness.activeProvider, model: consciousness.activeModel },
      vision: { provider: vision.activeProvider, model: vision.activeModel },
      speech: { provider: speech.activeSpeechProvider, model: speech.activeSpeechModel, voice_id: speech.activeSpeechVoiceId },
    }
  }

  /**
   * NOTICE: upstream 0.13 also blanks a module selection whose provider was disabled by logging out
   * (`configuredBy === 'authentication'`). This fork has no account system, so every provider is
   * local and the selection stands. Restore that branch together with the hosted auth store.
   */
  function resolveModules(modules: AiriExtension['modules'], defaults: CardModuleDefaults): CardModuleDefaults {
    const speechSelection = resolveModuleSelection(modules.speech, defaults.speech)
    return {
      consciousness: resolveModuleSelection(modules.consciousness, defaults.consciousness),
      vision: resolveModuleSelection(modules.vision, defaults.vision),
      speech: {
        ...speechSelection,
        voice_id: modules.speech.voice_id || (
          speechSelection.provider === defaults.speech.provider && speechSelection.model === defaults.speech.model
            ? defaults.speech.voice_id
            : ''
        ),
      },
    }
  }

  /**
   * The module selections of every character, resolved against the defaults, by character id.
   * The settings home reads it to find the providers in use and the characters that cannot speak.
   */
  const characterModules = computed<ReadonlyMap<string, CardModuleDefaults>>(() => {
    const defaults = moduleDefaults.value
    if (!defaults)
      return new Map<string, CardModuleDefaults>()
    return new Map([...cards.value].map(([id, card]) => [id, resolveModules(card.extensions.airi.modules, defaults)]))
  })

  function rememberInheritedSettings() {
    const runtime = readRuntimeModules()
    const defaults = moduleDefaults.value
    if (!defaults) {
      moduleDefaults.value = runtime
      return
    }
    if (!appliedModules)
      return

    // A user can change an inherited setting through a module surface. Retain
    // those changes, but never promote the previous card's overrides to defaults.
    const next = structuredClone(toRaw(defaults))
    for (const module of ['consciousness', 'vision', 'speech'] as const) {
      const previous = appliedModules[module]
      if (previous.provider)
        continue
      if (next[module].provider !== runtime[module].provider)
        next[module].model = ''
      next[module].provider = runtime[module].provider
      if (!previous.model)
        next[module].model = runtime[module].model
    }
    if (!appliedModules.speech.provider && !appliedModules.speech.model && !appliedModules.speech.voice_id)
      next.speech.voice_id = runtime.speech.voice_id
    if (!isEqual(next, toRaw(defaults)))
      moduleDefaults.value = next
  }

  /**
   * Keeps inherited defaults in step with the runtime modules after a card applies.
   * A module store can change an inherited selection later, for example when the official voice catalog picks a voice.
   * Replies resolve speech from the card and the defaults, so the defaults must follow.
   * The watcher starts at the first application, because metadata-only consumers must not create the module stores.
   */
  function followInheritedSettings() {
    if (followingInheritedSettings)
      return
    followingInheritedSettings = true
    // An action runs outside the store scope. Run the watcher in it, so the store disposal stops it.
    storeScope?.run(() => watch(readRuntimeModules, () => {
      // An application clears `appliedModules` while the runtime holds a mix of two cards.
      if (appliedModules)
        rememberInheritedSettings()
    }, { deep: true }))
  }

  /** Applies card speech through the leader command so catalog invalidation precedes its saved voice. */
  async function writeRuntimeModules(modules: CardModuleDefaults) {
    const { consciousness, vision, speech } = useRuntimeModuleStores()
    // Provider changes synchronously clear dependent selections. Assign the
    // resolved model and voice afterwards, including empty values.
    consciousness.activeProvider = modules.consciousness.provider
    consciousness.activeModel = modules.consciousness.model
    vision.activeProvider = modules.vision.provider
    vision.activeModel = modules.vision.model
    await speech.selectProviderModel(modules.speech.provider, modules.speech.model, modules.speech.voice_id)
  }

  const addCard = async (card: AiriCard | Card | ccv3.CharacterCardV3, displayModelId?: string) => {
    const newCardId = nanoid()
    const newCard = newAiriCard(toRaw(card))
    cards.value.set(newCardId, newCard)

    if (displayModelId)
      await setCharacterDefaultAvatarModelFromDisplayModel(newCardId, displayModelId)

    return newCardId
  }

  const removeCard = async (id: string) => {
    // The built-in card is the guaranteed fallback for every runtime profile.
    if (id === 'default')
      return false

    const removed = cards.value.delete(id)
    if (!removed)
      return false

    // The active id is persisted independently from the card map. Reset it
    // before consumers observe a dangling runtime profile after deletion.
    if (activeCardId.value === id) {
      activeCardId.value = 'default'
      persistActiveCardId(activeCardId.value)
      selectedAvatarModelId.value = resolveDefaultAvatarModelId()
      await applyActiveCardSettings()
    }

    return true
  }

  const updateCard = async (id: string, updates: AiriCard | Card | ccv3.CharacterCardV3, displayModelId?: string) => {
    const existingCard = toRaw(cards.value.get(id))
    if (!existingCard)
      return false

    const updatedCard = {
      ...existingCard,
      ...updates,
    }

    const card = newAiriCard(updatedCard)
    cards.value.set(id, card)
    let editedAvatarModelId: string | undefined
    if (displayModelId !== undefined)
      editedAvatarModelId = await setCharacterDefaultAvatarModelFromDisplayModel(id, displayModelId)

    if (id === activeCardId.value) {
      if (displayModelId !== undefined)
        selectedAvatarModelId.value = editedAvatarModelId
      await applyActiveCardSettings()
    }

    return true
  }

  const getCard = (id: string) => {
    return cards.value.get(id)
  }

  async function ensureAvatarModel(characterId: string, displayModelId: string) {
    const card = toRaw(cards.value.get(characterId))
    if (!card)
      return

    const existing = card.extensions.airi.avatarModels.find(model => model.displayModelId === displayModelId)
    if (existing)
      return existing.id

    const displayModel = await displayModels.getDisplayModel(displayModelId)
    if (!displayModel)
      return

    const avatarModel = createAvatarModelReference(displayModelId, displayModel.format)
    cards.value.set(characterId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...card.extensions.airi,
          avatarModels: [...card.extensions.airi.avatarModels, avatarModel],
        },
      },
    })

    return avatarModel.id
  }

  function setCharacterDefaultAvatarModel(characterId: string, avatarModelId: string | undefined) {
    const card = toRaw(cards.value.get(characterId))
    if (!card)
      return false

    const avatarModel = avatarModelId
      ? card.extensions.airi.avatarModels.find(model => model.id === avatarModelId)
      : undefined
    if (avatarModelId && !avatarModel)
      return false

    cards.value.set(characterId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...card.extensions.airi,
          defaultAvatarModelId: avatarModelId,
        },
      },
    })

    return true
  }

  async function setCharacterDefaultAvatarModelFromDisplayModel(characterId: string, displayModelId: string) {
    const avatarModelId = displayModelId
      ? await ensureAvatarModel(characterId, displayModelId)
      : undefined
    if (displayModelId && !avatarModelId)
      return

    setCharacterDefaultAvatarModel(characterId, avatarModelId)
    return avatarModelId
  }

  async function updateLive2DControlPolicy(characterId: string, avatarModelId: string, policy: Live2DControlPolicy) {
    const card = toRaw(cards.value.get(characterId))
    if (!card)
      return false

    const avatarModelIndex = card.extensions.airi.avatarModels.findIndex(model => model.id === avatarModelId)
    const avatarModel = card.extensions.airi.avatarModels[avatarModelIndex]
    if (!avatarModel || avatarModel.type !== 'live2d')
      return false

    const avatarModels = [...card.extensions.airi.avatarModels]
    avatarModels[avatarModelIndex] = {
      ...avatarModel,
      config: {
        ...avatarModel.config,
        controls: {
          disabledExpressions: [...policy.disabledExpressions],
          disabledMotions: [...policy.disabledMotions],
        },
      },
    }
    cards.value.set(characterId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...card.extensions.airi,
          avatarModels,
        },
      },
    })

    return true
  }

  function updateActiveCardModules(patch: (extension: AiriExtension) => Partial<AiriExtension['modules']>) {
    const cardId = activeCardId.value
    const card = toRaw(cards.value.get(cardId))
    if (!card)
      return false

    const extension = resolveAiriExtension(card)
    cards.value.set(cardId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...extension,
          modules: {
            ...extension.modules,
            ...patch(extension),
          },
        },
      },
    })

    return true
  }

  async function setActiveCardDefaultAvatarModel(displayModelId: string | undefined) {
    const avatarModelId = await setCharacterDefaultAvatarModelFromDisplayModel(activeCardId.value, displayModelId ?? '')
    if (displayModelId && !avatarModelId)
      return false

    return selectAvatarModel(avatarModelId)
  }

  /**
   * Removes the references to deleted Display Models from every Character and
   * selects an available default.
   *
   * Only the deleted IDs are removed. A synchronized card can reference a
   * Display Model that only another device stores. That reference must stay,
   * or the removal syncs to that device and deletes its link to the model.
   */
  async function removeDeletedAvatarModels(deletedDisplayModelIds: readonly string[], availableDisplayModelIds: readonly string[]) {
    const deleted = new Set(deletedDisplayModelIds)
    for (const [characterId, storedCard] of cards.value) {
      const card = toRaw(storedCard)
      const extension = card.extensions.airi
      const avatarModels = extension.avatarModels.filter(model => !deleted.has(model.displayModelId))
      if (avatarModels.length === extension.avatarModels.length)
        continue

      let defaultAvatarModelId = extension.defaultAvatarModelId
      if (defaultAvatarModelId && !avatarModels.some(model => model.id === defaultAvatarModelId)) {
        let fallback = avatarModels.find(model => model.displayModelId === BUILT_IN_DISPLAY_MODEL_ID) ?? avatarModels[0]
        if (!fallback) {
          for (const displayModelId of availableDisplayModelIds) {
            const displayModel = await displayModels.getDisplayModel(displayModelId)
            if (!displayModel)
              continue

            fallback = createAvatarModelReference(displayModel.id, displayModel.format)
            avatarModels.push(fallback)
            break
          }
        }
        defaultAvatarModelId = fallback?.id
      }

      cards.value.set(characterId, {
        ...card,
        extensions: {
          ...card.extensions,
          airi: { ...extension, avatarModels, defaultAvatarModelId },
        },
      })
    }

    if (!activeAvatarModels.value.some(model => model.id === selectedAvatarModelId.value)) {
      selectedAvatarModelId.value = resolveDefaultAvatarModelId()
      await applyActiveAvatarModel()
    }
  }

  // The display model store of each window reports the deletions that the window makes.
  // Call through the store, so the synchronized action runs in the leader.
  displayModels.onDisplayModelsDeleted(async (ids) => {
    await useAiriCardStore(pinia).removeDeletedAvatarModels(ids, displayModels.displayModels.map(model => model.id))
  })

  async function updateActiveCardConsciousness(consciousness: AiriExtension['modules']['consciousness']) {
    const updated = updateActiveCardModules(() => ({ consciousness }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  async function updateActiveCardVision(vision: AiriExtension['modules']['vision']) {
    const updated = updateActiveCardModules(() => ({ vision }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  /**
   * Selects a vision provider for the active card with its catalog default.
   *
   * Only this explicit selection applies the default, and the card stores it,
   * so the runtime and the card keep the same model. A provider without a
   * default keeps an empty model until the user selects one.
   */
  async function selectActiveCardVisionProvider(provider: string) {
    const vision = useVisionStore()
    // Choosing a provider turns the module on again. Without this line, a card
    // keeps the vision module off and the choice has no effect.
    vision.enabled = true
    // A repeated choice must not drop the model that the card already stores.
    if (vision.activeProvider === provider)
      return true
    vision.activeProvider = provider
    vision.resetModelSelection()
    await vision.loadModelsForProvider(provider)
    const model = useProviderStore().getDefaultModelForProvider(provider) ?? ''
    return await updateActiveCardVision({ provider, model })
  }

  async function updateActiveCardSpeech(speech: Pick<AiriExtension['modules']['speech'], 'provider' | 'model' | 'voice_id'>) {
    const updated = updateActiveCardModules(({ modules }) => ({
      speech: {
        ...modules.speech,
        ...speech,
      },
    }))
    if (updated)
      await applyActiveCardSettings()
    return updated
  }

  /** Clears a removed provider from defaults and the active card, not other cards. */
  async function clearProviderSelections(providerId: string) {
    rememberInheritedSettings()
    const defaults = moduleDefaults.value
    if (!defaults)
      return
    const next = structuredClone(toRaw(defaults))
    for (const module of ['consciousness', 'vision', 'speech'] as const) {
      if (next[module].provider === providerId) {
        next[module].provider = module === 'speech' ? 'speech-noop' : ''
        next[module].model = ''
        if (module === 'speech')
          next.speech.voice_id = ''
      }
    }
    moduleDefaults.value = next
    updateActiveCardModules(({ modules }) => ({
      consciousness: modules.consciousness.provider === providerId ? { provider: '', model: '' } : modules.consciousness,
      vision: modules.vision.provider === providerId ? { provider: '', model: '' } : modules.vision,
      speech: modules.speech.provider === providerId ? { ...modules.speech, provider: '', model: '', voice_id: '' } : modules.speech,
    }))
    appliedModules = undefined
    await applyActiveCardSettings()
  }

  function resolveAiriExtension(card: Card | ccv3.CharacterCardV3): AiriExtension {
    // Get existing extension if available
    const existingExtension = ('data' in card
      ? card.data?.extensions?.airi
      : card.extensions?.airi) as AiriExtension

    // Create default modules config
    const defaultModules = {
      consciousness: { provider: '', model: '' },
      vision: { provider: '', model: '' },
      speech: { provider: '', model: '', voice_id: '' },
      artistry: {
        enabled: false,
        provider: '',
        model: '',
        promptPrefix: '',
        widgetInstruction: DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT,
        spawnMode: 'bg_widget' as const,
        options: undefined,
        autonomousEnabled: false,
        autonomousThreshold: 70,
        autonomousTarget: 'assistant' as const,
      },
    } as const

    // Return default if no extension exists
    if (!existingExtension) {
      return {
        avatarModels: [],
        modules: defaultModules,
        agents: {},
      }
    }

    const avatarModels = existingExtension.avatarModels
      ? [...existingExtension.avatarModels]
      : []
    const defaultAvatarModelId = existingExtension.defaultAvatarModelId
    const hasDefaultAvatarModel = avatarModels.some(model => model.id === defaultAvatarModelId)
    const existingModules = { ...existingExtension.modules }
    Reflect.deleteProperty(existingModules, 'displayModelId')

    // Fill known fields without discarding settings owned by imported extensions.
    return {
      ...existingExtension,
      ...(existingExtension.wakeWords === undefined ? {} : { wakeWords: parse(array(wakeWordSchema), existingExtension.wakeWords) }),
      avatarModels,
      defaultAvatarModelId: hasDefaultAvatarModel ? defaultAvatarModelId : undefined,
      modules: {
        ...existingModules,
        consciousness: {
          ...existingExtension.modules?.consciousness,
          provider: existingExtension.modules?.consciousness?.provider ?? defaultModules.consciousness.provider,
          model: existingExtension.modules?.consciousness?.model ?? defaultModules.consciousness.model,
        },
        vision: {
          ...existingExtension.modules?.vision,
          provider: existingExtension.modules?.vision?.provider ?? defaultModules.vision.provider,
          model: existingExtension.modules?.vision?.model ?? defaultModules.vision.model,
        },
        speech: {
          ...existingExtension.modules?.speech,
          provider: existingExtension.modules?.speech?.provider ?? defaultModules.speech.provider,
          model: existingExtension.modules?.speech?.model ?? defaultModules.speech.model,
          voice_id: existingExtension.modules?.speech?.voice_id ?? defaultModules.speech.voice_id,
          pitch: existingExtension.modules?.speech?.pitch,
          rate: existingExtension.modules?.speech?.rate,
          ssml: existingExtension.modules?.speech?.ssml,
          language: existingExtension.modules?.speech?.language,
        },
        vrm: existingExtension.modules?.vrm,
        live2d: existingExtension.modules?.live2d,
        activeBackgroundId: existingExtension.modules?.activeBackgroundId,
        artistry: {
          ...existingExtension.modules?.artistry,
          enabled: existingExtension.modules?.artistry?.enabled ?? (existingExtension as any).artistry?.enabled ?? defaultModules.artistry.enabled,
          provider: existingExtension.modules?.artistry?.provider ?? (existingExtension as any).artistry?.provider ?? defaultModules.artistry.provider,
          model: existingExtension.modules?.artistry?.model ?? (existingExtension as any).artistry?.model ?? defaultModules.artistry.model,
          promptPrefix: existingExtension.modules?.artistry?.promptPrefix ?? (existingExtension as any).artistry?.promptPrefix ?? (existingExtension as any).artistry?.prompt_prefix ?? defaultModules.artistry.promptPrefix,
          workflowId: existingExtension.modules?.artistry?.workflowId ?? (existingExtension as any).artistry?.workflowId ?? (existingExtension as any).artistry?.remixId,
          widgetInstruction: existingExtension.modules?.artistry?.widgetInstruction ?? (existingExtension as any).artistry?.widgetInstruction ?? defaultModules.artistry.widgetInstruction,
          spawnMode: existingExtension.modules?.artistry?.spawnMode ?? (existingExtension as any).artistry?.spawnMode ?? defaultModules.artistry.spawnMode,
          options: existingExtension.modules?.artistry?.options ?? (existingExtension as any).artistry?.options ?? defaultModules.artistry.options,
          autonomousEnabled: existingExtension.modules?.artistry?.autonomousEnabled ?? (existingExtension as any).artistry?.autonomousEnabled ?? defaultModules.artistry.autonomousEnabled,
          autonomousThreshold: existingExtension.modules?.artistry?.autonomousThreshold ?? (existingExtension as any).artistry?.autonomousThreshold ?? defaultModules.artistry.autonomousThreshold,
          autonomousTarget: existingExtension.modules?.artistry?.autonomousTarget ?? (existingExtension as any).artistry?.autonomousTarget ?? defaultModules.artistry.autonomousTarget,
        },
      },
      agents: existingExtension.agents ?? {},
    }
  }

  function newAiriCard(card: Card | ccv3.CharacterCardV3): AiriCard {
    // Handle ccv3 format if needed
    if ('data' in card) {
      const ccv3Card = card as ccv3.CharacterCardV3
      return {
        name: ccv3Card.data.name,
        version: ccv3Card.data.character_version ?? '1.0.0',
        description: ccv3Card.data.description ?? '',
        creator: ccv3Card.data.creator ?? '',
        notes: ccv3Card.data.creator_notes ?? '',
        notesMultilingual: ccv3Card.data.creator_notes_multilingual,
        personality: ccv3Card.data.personality ?? '',
        scenario: ccv3Card.data.scenario ?? '',
        greetings: [
          ccv3Card.data.first_mes,
          ...(ccv3Card.data.alternate_greetings ?? []),
        ],
        greetingsGroupOnly: ccv3Card.data.group_only_greetings ?? [],
        systemPrompt: ccv3Card.data.system_prompt ?? '',
        postHistoryInstructions: ccv3Card.data.post_history_instructions ?? '',
        messageExample: ccv3Card.data.mes_example
          ? ccv3Card.data.mes_example
              .split('<START>\n')
              .filter(Boolean)
              .map(example => example.split('\n')
                .map((line) => {
                  if (line.startsWith('{{char}}:') || line.startsWith('{{user}}:'))
                    return line as `{{char}}: ${string}` | `{{user}}: ${string}`
                  throw new Error(`Invalid message example format: ${line}`)
                }))
          : [],
        tags: ccv3Card.data.tags ?? [],
        extensions: {
          ...ccv3Card.data.extensions,
          airi: resolveAiriExtension(ccv3Card),
        },
      }
    }

    return {
      ...card,
      extensions: {
        ...card.extensions,
        airi: resolveAiriExtension(card),
      },
    }
  }

  /**
   * The `default` card before the user edits it. Each device creates this card
   * with the same id, so synchronization compares a device's card with it to
   * find the edits of the user.
   */
  const builtInCard = computed(() => newAiriCard({
    name: 'ReLU',
    version: '1.0.0',
    description: t('base.prompt.prefix'),
    extensions: {
      airi: {
        // Every device ships the preset model, so this reference is part of the
        // built-in content. An unedited `default` card then sends no avatar fields.
        defaultAvatarModelId: 'default-live2d-avatar-model',
        avatarModels: [{
          id: 'default-live2d-avatar-model',
          displayModelId: 'preset-live2d-1',
          type: 'live2d',
          config: {
            controls: {
              disabledExpressions: [],
              disabledMotions: [],
            },
          },
        }],
        modules: {
          consciousness: { provider: '', model: '' },
          speech: { provider: '', model: '', voice_id: '' },
          vision: { provider: '', model: '' },
        },
        agents: {},
      },
    },
  }))

  /** Applies the initial card once. Each window calls it after the runtime stores exist. */
  async function initialize() {
    // This synchronized action executes in the leader. Each window calls it,
    // but only the first call can apply persisted card settings to the runtime.
    if (initialized)
      return

    initialized = true
    // NOTICE:
    // Cards saved before Avatar Models store their model in `modules.displayModelId`.
    // Normalization deletes it, so move it into an Avatar Model reference first.
    // Source: PR #2458 replaced `modules.displayModelId` with `avatarModels`.
    // Removal condition: one stable release after the first stable release with PR #2458.
    const legacyDisplayModelIds = new Map<string, string>()
    for (const [id, card] of cards.value) {
      const legacyDisplayModelId = legacyDisplayModelIdOf(toRaw(card))
      // The built-in card keeps its built-in reference for the bundled preset.
      // The backfill below adds it, so an unedited built-in card syncs no fields.
      if (legacyDisplayModelId && (id !== 'default' || legacyDisplayModelId !== BUILT_IN_DISPLAY_MODEL_ID))
        legacyDisplayModelIds.set(id, legacyDisplayModelId)

      const normalizedCard = newAiriCard(toRaw(card))
      cards.value.set(id, normalizedCard)
    }
    // A model that this device does not store gives no reference. The Stage then
    // asks the user to select a model.
    for (const [id, displayModelId] of legacyDisplayModelIds)
      await setCharacterDefaultAvatarModelFromDisplayModel(id, displayModelId)

    if (!cards.value.has('default'))
      cards.value.set('default', structuredClone(toRaw(builtInCard.value)))

    // Stored speech-noop can mean an intentional mute. Only the editor may
    // replace it with inheritance; the old placeholder has no provenance marker.
    // The active id and card map are persisted separately. Older versions
    // could delete the selected card without repairing its stored id.
    if (!cards.value.has(activeCardId.value))
      activeCardId.value = 'default'
    persistActiveCardId(activeCardId.value)

    // NOTICE:
    // The built-in card stored before PR #2458 has no Avatar Model. Give it the
    // bundled preset when the migration above found no model for it.
    // Removal condition: the same as the migration above.
    const defaultCard = toRaw(cards.value.get('default'))
    if (defaultCard && defaultCard.extensions.airi.avatarModels.length === 0) {
      cards.value.set('default', {
        ...defaultCard,
        extensions: {
          ...defaultCard.extensions,
          airi: {
            ...defaultCard.extensions.airi,
            defaultAvatarModelId: builtInCard.value.extensions.airi.defaultAvatarModelId,
            avatarModels: structuredClone(toRaw(builtInCard.value.extensions.airi.avatarModels)),
          },
        },
      })
    }

    // NOTICE:
    // Up to v0.12.0-beta.5 the Stage model was also stored in `settings/stage/model`.
    // PR #2458 stopped reading it, so an upgrade showed the bundled preset.
    // Move it once, only into a card that shows the bundled preset.
    // Removal condition: the same as the migration above.
    const legacyStageModelId = globalThis.localStorage?.getItem(LEGACY_STAGE_MODEL_STORAGE_KEY)
    if (legacyStageModelId) {
      const card = toRaw(cards.value.get(activeCardId.value))
      const cardDefaultAvatarModelId = card?.extensions.airi.defaultAvatarModelId
      const cardDisplayModelId = card?.extensions.airi.avatarModels.find(model => model.id === cardDefaultAvatarModelId)?.displayModelId
      if (legacyStageModelId !== BUILT_IN_DISPLAY_MODEL_ID && (!cardDisplayModelId || cardDisplayModelId === BUILT_IN_DISPLAY_MODEL_ID))
        await setCharacterDefaultAvatarModelFromDisplayModel(activeCardId.value, legacyStageModelId)
      // A model that this device does not store gives no reference, as above.
      // Remove the key in all cases, so that the migration runs only once.
      localStorage.removeItem(LEGACY_STAGE_MODEL_STORAGE_KEY)
    }

    if (!activeAvatarModels.value.some(model => model.id === selectedAvatarModelId.value))
      selectedAvatarModelId.value = resolveDefaultAvatarModelId()

    await applyActiveCardSettings()
    ready.value = true
  }

  /**
   * Selects a card and applies its module settings in the synchronization
   * leader. Replicated state snapshots never invoke this command.
   */
  async function activateCard(id: string) {
    if (!cards.value.has(id))
      return false

    activeCardId.value = id
    persistActiveCardId(id)
    selectedAvatarModelId.value = resolveDefaultAvatarModelId()
    await applyActiveCardSettings()
    return true
  }

  async function selectAvatarModel(id: string | undefined) {
    if (id && !activeAvatarModels.value.some(model => model.id === id))
      return false

    selectedAvatarModelId.value = id
    await applyActiveAvatarModel()
    return true
  }

  async function applyActiveAvatarModel() {
    // The stage model store loads the model, downloads it from the account when needed, and
    // reports a model that this device cannot load. The card keeps its reference in every case,
    // so a synchronized card still shows its model on the device that stores it.
    useSettingsStageModel(pinia).stageModelSelected = selectedAvatarModel.value?.displayModelId ?? ''
    await loadActiveLive2DModelControls()
  }

  async function loadActiveLive2DModelControls() {
    const generation = ++live2DControlLoadGeneration
    activeLive2DModelControls.value = emptyLive2DModelControls

    const avatarModel = selectedAvatarModel.value
    if (avatarModel?.type !== 'live2d')
      return

    try {
      const displayModel = await displayModels.getDisplayModel(avatarModel.displayModelId)
      if (!displayModel || generation !== live2DControlLoadGeneration)
        return

      let archive: Blob
      if (displayModel.type === 'file') {
        archive = displayModel.file
      }
      else {
        const response = await fetch(displayModel.url)
        if (!response.ok)
          throw new Error(`Failed to load the Live2D archive (${response.status} ${response.statusText}).`)
        archive = await response.blob()
      }

      const controls = await inspectLive2DModelControls(archive)
      if (generation === live2DControlLoadGeneration)
        activeLive2DModelControls.value = controls
    }
    catch (error) {
      if (generation === live2DControlLoadGeneration)
        console.warn('[AiriCard] Failed to inspect Live2D controls.', errorMessageFrom(error))
    }
  }

  /** Resolve the named character without changing the character selected by any window. */
  function getModules(characterId: string): CardModuleDefaults {
    const card = cards.value.get(characterId)
    if (!card)
      throw new Error('The session character is unavailable')
    const defaults = moduleDefaults.value
    if (!defaults)
      throw new Error('Character defaults are not initialized')
    return resolveModules(card.extensions.airi.modules, defaults)
  }

  function resolveModules(modules: AiriExtension['modules'], defaults: CardModuleDefaults): CardModuleDefaults {
    const speechSelection = resolveModuleSelection(modules.speech, defaults.speech)
    const resolved: CardModuleDefaults = {
      consciousness: resolveModuleSelection(modules.consciousness, defaults.consciousness),
      vision: resolveModuleSelection(modules.vision, defaults.vision),
      speech: {
        ...speechSelection,
        voice_id: modules.speech.voice_id || (
          speechSelection.provider === defaults.speech.provider && speechSelection.model === defaults.speech.model
            ? defaults.speech.voice_id
            : ''
        ),
      },
    }
    return resolved
  }

  function getSystemPrompt(characterId: string) {
    // Live2D controls are inspected only for the active Avatar Model. Another
    // Character gets its prompt without ACT controls until it becomes active.
    if (characterId === activeCardId.value)
      return resolveSystemPrompt(cards.value.get(characterId), enabledLive2DExpressions.value, enabledLive2DMotions.value)

    return resolveSystemPrompt(cards.value.get(characterId), emptyLive2DExpressions, emptyLive2DMotions)
  }

  async function applyActiveCardSettings(newCard = activeCard.value) {
    rememberInheritedSettings()
    // The runtime holds a mix of two cards until the write completes. See followInheritedSettings.
    appliedModules = undefined
    const artistry = useArtistryStore()

    artistry.resetToGlobal()

    if (!newCard)
      return

    // TODO: Minecraft Agent, etc
    const extension = resolveAiriExtension(newCard)
    if (!extension)
      return

    const defaults = moduleDefaults.value
    if (!defaults)
      return
    const modules = extension.modules
    const resolved = resolveModules(modules, defaults)
    await writeRuntimeModules(resolved)
    appliedModules = modules
    followInheritedSettings()
    await applyActiveAvatarModel()

    if (extension.modules?.artistry) {
      const selection = resolveModuleSelection({
        provider: extension.modules.artistry.provider ?? '',
        model: extension.modules.artistry.model ?? '',
      }, { provider: artistry.globalProvider, model: artistry.globalModel })
      artistry.activeProvider = selection.provider
      artistry.activeModel = selection.model
      if (selection.provider !== artistry.globalProvider)
        artistry.providerOptions = undefined
      if (extension.modules.artistry.promptPrefix)
        artistry.defaultPromptPrefix = extension.modules.artistry.promptPrefix
      if (extension.modules.artistry.options)
        artistry.providerOptions = extension.modules.artistry.options
    }
  }

  function resetState() {
    initialized = false
    ready.value = false
    appliedModules = undefined
    moduleDefaults.reset()
    cards.reset()
    activeCardId.value = 'default'
    selectedAvatarModelId.value = undefined
    clearPersistedActiveCardId()
  }

  return {
    cards,
    moduleDefaults,
    characterModules,
    activeCard,
    activeCardId,
    builtInCard,
    ready,
    selectedAvatarModel,
    selectedAvatarModelId,
    activeLive2DModelControls,
    addCard,
    removeCard,
    updateCard,
    updateActiveCardConsciousness,
    setActiveCardDefaultAvatarModel,
    removeDeletedAvatarModels,
    updateActiveCardSpeech,
    updateActiveCardVision,
    selectActiveCardVisionProvider,
    getCard,
    getModules,
    getSystemPrompt,
    resetState,
    selectAvatarModel,
    updateLive2DControlPolicy,
    initialize,
    activateCard,
    clearProviderSelections,

    currentModels: computed(() => {
      const {
        consciousness,
        speech,
        vision,
      } = useRuntimeModuleStores()

      return {
        consciousness: {
          provider: consciousness.activeProvider,
          model: consciousness.activeModel,
        },
        vision: {
          provider: vision.activeProvider,
          model: vision.activeModel,
        },
        speech: {
          provider: speech.activeSpeechProvider,
          model: speech.activeSpeechModel,
          voice_id: speech.activeSpeechVoiceId,
        },
        activeBackgroundId: activeCard.value?.extensions?.airi?.modules?.activeBackgroundId,
      } satisfies AiriExtension['modules']
    }),
    systemPrompt: computed(() => resolveSystemPrompt(
      activeCard.value,
      enabledLive2DExpressions.value,
      enabledLive2DMotions.value,
    )),
  }
}, {
  synced: {
    actions: [
      'activateCard',
      'addCard',
      'initialize',
      'clearProviderSelections',
      'removeCard',
      'selectAvatarModel',
      'updateActiveCardConsciousness',
      'setActiveCardDefaultAvatarModel',
      'removeDeletedAvatarModels',
      'updateActiveCardSpeech',
      'updateActiveCardVision',
      'selectActiveCardVisionProvider',
      'updateCard',
      'updateLive2DControlPolicy',
    ],
    state: true,
  },
})
