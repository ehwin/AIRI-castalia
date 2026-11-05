import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useProviderConfigStore } from '../providers/config'
import { useProviderStore } from '../providers/provider'
import { speechFieldsKeyOf, speechFieldStatus, toSignedPercent, useSpeechStore } from './speech'

const i18nState = vi.hoisted(() => ({
  locale: { value: 'en-US' },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: i18nState.locale,
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('speech store helpers', () => {
  beforeEach(() => {
    i18nState.locale.value = 'en-US'
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('formats positive percentages with a plus sign', () => {
    expect(toSignedPercent(25)).toBe('+25%')
  })

  it('formats negative percentages without a double minus', () => {
    expect(toSignedPercent(-20)).toBe('-20%')
    expect(toSignedPercent(-20)).not.toContain('--')
  })

  it('formats zero as 0%', () => {
    expect(toSignedPercent(0)).toBe('0%')
  })

  // ROOT CAUSE:
  //
  // The speech store watched its model-list projection even when no UI used
  // that projection. Each synced provider snapshot invalidated the projection.
  // The watcher then called getModelsForProvider twice when the cache was empty.
  //
  // We fixed this by keeping model selection behind explicit operations. A UI
  // consumer can still read providerModels when it needs the cached catalog.
  it('keeps the selected provider while provider snapshots are incomplete', async () => {
    const providersStore = useProviderStore()
    const providerConfigStore = useProviderConfigStore()
    vi.spyOn(providersStore, 'listProviderVoices').mockResolvedValue([])
    const speechStore = useSpeechStore()
    await providersStore.initializeProvider('microsoft-speech')
    providersStore.forceProviderConfigured('microsoft-speech')
    speechStore.activeSpeechProvider = 'microsoft-speech'
    speechStore.activeSpeechModel = 'auto'
    await vi.waitFor(() => {
      expect(providersStore.configuredSpeechProvidersMetadata.map(provider => provider.id)).toContain('microsoft-speech')
    })

    providersStore.providerRuntimeState = {}
    providerConfigStore.providers = {}
    await vi.waitFor(() => {
      expect(providersStore.configuredSpeechProvidersMetadata.map(provider => provider.id)).not.toContain('microsoft-speech')
    })

    expect(speechStore.activeSpeechProvider).toBe('microsoft-speech')
    expect(speechStore.activeSpeechModel).toBe('auto')
  })

  /**
   * @example
   * speechStore.resolveSpeechInput({ text, voice, providerConfig: { voice: 'plain' } })
   */
  it('leaves speech input unchanged by default', () => {
    const speechStore = useSpeechStore()
    const voice = {
      id: 'plain-voice',
      name: 'Plain Voice',
      provider: 'openai-compatible-audio-speech',
      languages: [{ code: 'en-US', title: 'English' }],
    }

    const request = speechStore.resolveSpeechInput({
      text: 'hello',
      voice,
      providerConfig: { voice: 'plain-voice' },
    })

    expect(request.input).toBe('hello')
    expect(request.providerConfig).toEqual({ voice: 'plain-voice' })
  })
})

describe('single model speech providers', () => {
  // Selecting a provider makes the speech store load its voices. Without a stub
  // the VOICEVOX entries reach for a real engine on localhost. The rejection
  // then logs after the file finishes, and the run fails on a teardown race.
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('fetch', async () => Response.json([]))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // https://github.com/moeru-ai/airi/issues/2166
  it('selects the only published model, so the provider is not left unconfigured — Issue #2166', async () => {
    // `settings/modules/speech.vue` clears `activeSpeechModel` on every provider
    // switch. Without the seeding below, a provider that publishes one model
    // keeps an empty model, `configured` stays false, and the stage never
    // speaks until the user opens the dropdown and picks that one entry.
    const providersStore = useProviderStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = 'voicevox'
    speechStore.activeSpeechModel = ''
    await providersStore.initializeProvider('voicevox')
    providersStore.providerRuntimeState.voicevox.models = [
      { id: 'default', name: 'VOICEVOX', provider: 'voicevox' },
    ]

    speechStore.ensureActiveSpeechModel()

    expect(speechStore.activeSpeechModel).toBe('default')
  })

  // https://github.com/moeru-ai/airi/pull/2490#discussion_r3967236129
  // ROOT CAUSE: Single-model defaults overwrote explicit names from the manual field.
  it('preserves a manually entered model through selection and catalog loading', async () => {
    const providers = useProviderStore()
    await providers.initializeProvider('openai-compatible-audio-speech')
    providers.providerRuntimeState['openai-compatible-audio-speech'].models = [
      { id: 'discovered', name: 'Discovered', provider: 'openai-compatible-audio-speech' },
    ]
    const speech = useSpeechStore()
    await speech.selectProviderModel('openai-compatible-audio-speech', 'manual-model')
    await speech.loadVoicesForProvider('openai-compatible-audio-speech', 'manual-model')
    expect(speech.activeSpeechModel).toBe('manual-model')
  })

  it('keeps the voice when it seeds the model, because voices belong to the provider', async () => {
    const providersStore = useProviderStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = 'voicevox'
    speechStore.activeSpeechModel = ''
    speechStore.activeSpeechVoiceId = '3'
    await providersStore.initializeProvider('voicevox')
    providersStore.providerRuntimeState.voicevox.models = [
      { id: 'default', name: 'VOICEVOX', provider: 'voicevox' },
    ]

    speechStore.ensureActiveSpeechModel()

    expect(speechStore.activeSpeechVoiceId).toBe('3')
  })

  it('does not guess when a provider publishes several models', async () => {
    const providersStore = useProviderStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = 'elevenlabs'
    speechStore.activeSpeechModel = ''
    await providersStore.initializeProvider('elevenlabs')
    providersStore.providerRuntimeState.elevenlabs.models = [
      { id: 'eleven_v3', name: 'v3', provider: 'elevenlabs' },
      { id: 'eleven_flash_v2_5', name: 'flash', provider: 'elevenlabs' },
    ]

    speechStore.ensureActiveSpeechModel()

    expect(speechStore.activeSpeechModel).toBe('')
  })
})

describe('vOICEVOX provider defaults', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // https://github.com/moeru-ai/airi/issues/2166
  it('persists the neutral volume default, so a new provider is not silent — Issue #2166', async () => {
    // The settings form seeds `{ pitch: 0, speed: 1, volume: 0 }` when the
    // stored configuration carries no voice settings, and a `volumeScale` of
    // zero is silence. Provider metadata resolves asynchronously, so this pins
    // that `initializeProvider` waits for it before it writes the schema
    // defaults into the stored configuration.
    const providersStore = useProviderStore()
    const providerConfigStore = useProviderConfigStore()

    await providersStore.initializeProvider('voicevox')

    expect(providerConfigStore.getProviderConfig('voicevox')?.voiceSettings)
      .toEqual({ speed: 1, pitch: 0, intonation: 1, volume: 1 })
  })
  // ROOT CAUSE: Model reloads lived in the settings page, so card changes bypassed them.
  // https://github.com/moeru-ai/airi/actions/runs/39113696560/job/117634993202
  // Catalog hashing is asynchronous. Wait for each request instead of assuming it finishes within 20 ms.
  it('refreshes voices when only the active model changes outside settings', async () => {
    const providers = useProviderStore()
    const loads = vi.spyOn(providers, 'listProviderVoices').mockResolvedValue([])
    const speech = useSpeechStore()
    speech.activeSpeechProvider = 'microsoft-speech'
    speech.activeSpeechModel = 'model-a'
    await vi.waitFor(() => {
      expect(loads).toHaveBeenCalledWith('microsoft-speech', 'model-a', expect.anything())
    })
    loads.mockClear()
    speech.activeSpeechModel = 'model-b'
    await vi.waitFor(() => {
      expect(loads).toHaveBeenCalledWith('microsoft-speech', 'model-b', expect.anything())
    })
  })

  // https://github.com/moeru-ai/airi/pull/2490#discussion_r3964660980
  // ROOT CAUSE: Every refresh cleared the catalog, even when its identity did
  // not change. A temporary failure then removed valid cached choices.
  it('retains the same catalog on refresh failure but clears it for a different model', async () => {
    const providers = useProviderStore()
    const voices = [{ id: 'cached', name: 'Cached', languages: [], provider: 'microsoft-speech' }]
    const loads = vi.spyOn(providers, 'listProviderVoices').mockResolvedValue(voices)
    const speech = useSpeechStore()
    await speech.loadVoicesForProvider('microsoft-speech', 'model-a')
    loads.mockRejectedValue(new Error('temporary outage'))
    await speech.loadVoicesForProvider('microsoft-speech', 'model-a')
    expect(speech.availableVoices['microsoft-speech']).toEqual(voices)
    expect(speech.voiceCatalogStatus['microsoft-speech']?.error).toBe('temporary outage')
    await speech.loadVoicesForProvider('microsoft-speech', 'model-b')
    expect(speech.availableVoices['microsoft-speech']).toEqual([])
  })

  // https://github.com/moeru-ai/airi/pull/2490#discussion_r3966034981
  // ROOT CAUSE: Synthesis settings changed the catalog fingerprint and cleared
  // a valid selection. Each adapter must identify its discovery inputs.
  it.each(['elevenlabs', 'voicevox', 'microsoft-speech'])('retains %s selection after synthesis settings change', async (provider) => {
    const voices = [{ id: 'selected', name: 'Selected', languages: [], provider }]
    vi.spyOn(useProviderStore(), 'listProviderVoices').mockResolvedValue(voices)
    const speech = useSpeechStore()
    await speech.selectProviderModel(provider, 'model')
    await vi.waitFor(() => expect(speech.isLoadingSpeechProviderVoices).toBe(false))
    const config = { apiKey: 'key', baseUrl: 'https://voices.invalid/', region: 'eastasia' }
    await speech.loadVoiceCatalog(provider, 'model', { definitionId: provider, config })
    speech.activeSpeechVoiceId = 'selected'
    await speech.ensureActiveSpeechVoice()
    await speech.loadVoiceCatalog(provider, 'model', {
      definitionId: provider,
      config: { ...config, pitch: 1, speed: 1.2, volume: 0.8, style: 'happy', voiceSettings: { stability: 0.7 } },
    })
    expect(speech.activeSpeechVoiceId).toBe('selected')
    expect(speech.activeSpeechVoice?.id).toBe('selected')
    expect(speech.configured).toBe(true)
  })

  it('invalidates cached voices when the discovery configuration changes', async () => {
    const providers = useProviderStore()
    const voices = [{ id: 'cached', name: 'Cached', languages: [], provider: 'microsoft-speech' }]
    const loads = vi.spyOn(providers, 'listProviderVoices').mockResolvedValue(voices)
    const speech = useSpeechStore()
    const original = { definitionId: 'microsoft-speech', config: { baseUrl: 'https://old.invalid/' } }
    const changed = { definitionId: 'microsoft-speech', config: { baseUrl: 'https://new.invalid/' } }
    await speech.loadVoiceCatalog('microsoft-speech', 'model-a', original)
    loads.mockRejectedValue(new Error('configuration unavailable'))
    await expect(speech.loadVoiceCatalog('microsoft-speech', 'model-a', changed)).rejects.toThrow('configuration unavailable')
    expect(speech.availableVoices['microsoft-speech']).toEqual([])
    loads.mockResolvedValue(voices)
    await speech.loadVoiceCatalog('microsoft-speech', 'model-a', changed)
    expect(speech.availableVoices['microsoft-speech']).toEqual(voices)
  })

  // ROOT CAUSE: A reset cleared the catalogs, but a pending hashing request
  // could write its result into the next catalog generation.
  it('discards a request reset while its configuration fingerprint is pending', async () => {
    const providers = useProviderStore()
    const original = providers.getVoiceCatalogIdentity.bind(providers)
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.spyOn(providers, 'getVoiceCatalogIdentity').mockImplementation(async (model, configuration) => {
      const identity = await original(model, configuration)
      if (model === 'delayed')
        await barrier
      return identity
    })
    const requests = vi.spyOn(providers, 'listProviderVoices').mockResolvedValue([])
    const speech = useSpeechStore()
    const pending = speech.loadVoiceCatalog('microsoft-speech', 'delayed', { definitionId: 'microsoft-speech', config: {} })
    await speech.resetState()
    finish()
    await expect(pending).resolves.toEqual([])
    expect(requests.mock.calls.some(([, model]) => model === 'delayed')).toBe(false)
    expect(speech.availableVoices['microsoft-speech']).toBeUndefined()
  })

  // https://github.com/moeru-ai/airi/pull/2490#discussion_r3964866488
  it('keeps large provider samples out of replicated speech state', async () => {
    vi.spyOn(useProviderStore(), 'listProviderVoices').mockResolvedValue([])
    const speech = useSpeechStore()
    await speech.loadVoiceCatalog('microsoft-speech', 'model-a', {
      definitionId: 'microsoft-speech',
      config: { voiceSample: 'private-sample'.repeat(100000) },
    })
    const state = JSON.stringify({ settings: speech.$state, identities: speech.voiceCatalogIdentities })
    expect(state.length).toBeLessThan(2000)
    expect(state).not.toContain('private-sample')
  })

  // ROOT CAUSE: The adapter wrote recommendations before the store discarded stale responses.
  it('keeps active provider status when another provider finishes first', async () => {
    const providers = useProviderStore()
    const loads = vi.spyOn(providers, 'listProviderVoices').mockResolvedValue([])
    const speech = useSpeechStore()
    speech.activeSpeechProvider = 'microsoft-speech'
    await new Promise(resolve => setTimeout(resolve, 20))
    let rejectActive!: (error: Error) => void
    loads.mockImplementation(async (provider) => {
      if (provider === 'microsoft-speech') {
        return new Promise((_resolve, reject) => {
          rejectActive = reject
        })
      }
      return []
    })
    const active = speech.loadVoicesForProvider('microsoft-speech')
    try {
      await vi.waitFor(() => expect(rejectActive).toBeDefined())
      await speech.loadVoicesForProvider('speech-noop')
      expect(speech.isLoadingSpeechProviderVoices).toBe(true)
      rejectActive(new Error('active provider failed'))
      await active
      expect(speech.speechProviderError).toBe('active provider failed')
      expect(speech.isLoadingSpeechProviderVoices).toBe(false)
    }
    finally {
      rejectActive?.(new Error('test cleanup'))
      await active
    }
  })
})

describe('speechFieldStatus', () => {
  // The hosted speech catalog went with the account layer, so no provider picks a voice for you
  // now (`picksSpeechVoiceAutomatically` is false in this fork). An empty voice is always missing.

  it('reports a missing voice of a provider that does not pick one, even while a catalog loads', () => {
    expect(speechFieldStatus({ provider: 'minimax-speech', model: 'speech-02-hd', voice_id: '' }, {}, () => undefined, true)).toEqual({ missing: ['voice'], pending: [] })
  })

  it('reports a missing model when the selection and the config carry none', () => {
    expect(speechFieldStatus({ provider: 'minimax-speech', model: '', voice_id: 'voice' }, {}, () => undefined, false)).toEqual({ missing: ['model'], pending: [] })
  })

  it('takes the model and the voice from the provider config', () => {
    expect(speechFieldStatus({ provider: 'openai-compatible-audio-speech', model: '', voice_id: '' }, { model: 'tts-1', voice: 'alloy' }, () => null, false)).toEqual({ missing: [], pending: [] })
  })

  it('reports nothing when speech is off', () => {
    expect(speechFieldStatus({ provider: 'speech-noop', model: '', voice_id: '' }, {}, () => null, false)).toEqual({ missing: [], pending: [] })
  })
})

describe('speechFieldsKeyOf', () => {
  it('names each set of fields with one key', () => {
    expect(speechFieldsKeyOf(['model'])).toBe('model')
    expect(speechFieldsKeyOf(['voice'])).toBe('voice')
    expect(speechFieldsKeyOf(['model', 'voice'])).toBe('model-voice')
    expect(speechFieldsKeyOf([])).toBeUndefined()
  })
})
