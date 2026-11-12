import type {
  ListVoicesOptions,
  UnDeepgramOptions,
  UnMicrosoftOptions,
  UnVolcengineOptions,
  VoiceProviderWithExtraOptions,
} from 'unspeech'

import type { ProviderContext, ProviderTranslator } from '../../../types'

import {
  createUnDeepgram,
  createUnMicrosoft,
  createUnVolcengine,
  listVoices,
} from 'unspeech'
import { z } from 'zod'

import { defineProvider } from '../../registry'

function getBailianSpeechBridge() {
  return (globalThis as typeof globalThis & { api?: { bailianSpeechSynthesize?: (endpoint: string, apiKey: string, body: string, requestId?: string) => Promise<Uint8Array> } }).api?.bailianSpeechSynthesize
}

function getBailianSpeechCancel() {
  return (globalThis as typeof globalThis & { api?: { bailianSpeechCancel?: (requestId: string) => void } }).api?.bailianSpeechCancel
}

/** Only used to let main find the request this segment started; it never leaves this process pair. */
function createSpeechRequestId() {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (crypto?.randomUUID)
    return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * The bridge is a plain `ipcRenderer.invoke`, which cannot carry an `AbortSignal`. Without this race an
 * interrupt leaves the renderer awaiting a request that main keeps running for up to its own timeout,
 * and the response's playback slots are reserved in creation order, so one stalled segment blocks the
 * audible segments queued behind it. Racing lets the speech queue move on, and `onAbort` tells main to
 * drop its side of the request instead of letting it finish and bill a synthesis nobody hears.
 */
function raceBailianBridge(pending: Promise<Uint8Array>, signal?: AbortSignal | null, onAbort?: () => void): Promise<Uint8Array> {
  if (!signal)
    return pending

  const abortReason = () => signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (signal.aborted) {
    pending.catch(() => {})
    onAbort?.()
    return Promise.reject(abortReason())
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const abort = () => {
      pending.catch(() => {})
      onAbort?.()
      reject(abortReason())
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

const unspeechConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().default('https://unspeech.hyp3r.link/v1/'),
})

const microsoftSpeechConfigSchema = unspeechConfigSchema.extend({
  region: z.string().optional(),
})

const volcengineSpeechConfigSchema = unspeechConfigSchema.extend({
  app: z.object({ appId: z.string() }),
})

type UnspeechConfig = z.input<typeof unspeechConfigSchema>
type MicrosoftSpeechConfig = z.input<typeof microsoftSpeechConfigSchema>
type VolcengineSpeechConfig = z.input<typeof volcengineSpeechConfigSchema>

function createUnspeechConfigSchema(schema: typeof volcengineSpeechConfigSchema, t: ProviderTranslator): typeof volcengineSpeechConfigSchema
function createUnspeechConfigSchema(schema: typeof microsoftSpeechConfigSchema, t: ProviderTranslator): typeof microsoftSpeechConfigSchema
function createUnspeechConfigSchema(schema: typeof unspeechConfigSchema, t: ProviderTranslator): typeof unspeechConfigSchema
function createUnspeechConfigSchema(
  schema: typeof unspeechConfigSchema | typeof microsoftSpeechConfigSchema | typeof volcengineSpeechConfigSchema,
  t: ProviderTranslator,
) {
  return schema.extend({
    apiKey: schema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: schema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  })
}

function toListVoicesOptions<T>(provider: VoiceProviderWithExtraOptions<T>, options?: T): ListVoicesOptions {
  const { fetch: _fetch, ...voiceOptions } = provider.voice(options)
  return voiceOptions
}

const alibabaCloudConfigSchema = unspeechConfigSchema.extend({
  baseUrl: z.string().default('https://ws-ntfc49ta9az8bvz7.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'),
})

type AlibabaCloudConfig = z.input<typeof alibabaCloudConfigSchema>

const ALIBABA_CLONED_VOICE = 'cosyvoice-v3.5-plus-bailian-48f9e6aa815148158d6f8a8630dc24d4'
const ALIBABA_DEFAULT_MODEL = 'cosyvoice-v3.5-plus'

async function readAlibabaAudioUrl(response: Response): Promise<string> {
  const body = await response.json() as { output?: { audio?: { url?: string } | string }, message?: string }
  const audio = body.output?.audio
  const url = typeof audio === 'string' ? audio : audio?.url
  if (!url)
    throw new Error(body.message || 'Alibaba Cloud TTS response did not contain an audio URL.')
  return url
}

function createAlibabaCloudNative(apiKey: string, endpoint: string) {
  return {
    speech: (model: string, options?: Record<string, unknown>) => ({
      apiKey,
      baseURL: endpoint,
      model: model || ALIBABA_DEFAULT_MODEL,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (!init?.body || typeof init.body !== 'string')
          throw new Error('Alibaba Cloud TTS request body is missing.')

        const request = JSON.parse(init.body) as {
          model?: string
          input?: string
          voice?: string
          response_format?: string
        }
        const bailianSpeechSynthesize = getBailianSpeechBridge()
        const speechRequest = JSON.stringify({
          model: request.model || model || ALIBABA_DEFAULT_MODEL,
          input: {
            text: request.input ?? '',
            voice: request.voice || (typeof options?.voice === 'string' ? options.voice : ALIBABA_CLONED_VOICE),
            format: request.response_format === 'wav' ? 'wav' : 'mp3',
            sample_rate: 24000,
          },
        })
        const speechRequestId = createSpeechRequestId()
        const audioBytes = bailianSpeechSynthesize
          ? await raceBailianBridge(
              bailianSpeechSynthesize(endpoint, apiKey, speechRequest, speechRequestId),
              init?.signal,
              () => getBailianSpeechCancel()?.(speechRequestId),
            )
          : await (async () => {
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  model: request.model || model || ALIBABA_DEFAULT_MODEL,
                  input: {
                    text: request.input ?? '',
                    voice: request.voice || (typeof options?.voice === 'string' ? options.voice : ALIBABA_CLONED_VOICE),
                    format: request.response_format === 'wav' ? 'wav' : 'mp3',
                    sample_rate: 24000,
                  },
                }),
                signal: init.signal,
              })
              if (!response.ok)
                throw new Error(`Alibaba Cloud TTS request failed: ${response.status} ${await response.text()}`)
              const audioUrl = await readAlibabaAudioUrl(response)
              const audio = await fetch(audioUrl, { signal: init.signal })
              if (!audio.ok)
                throw new Error(`Alibaba Cloud TTS audio download failed: ${audio.status}`)
              return new Uint8Array(await audio.arrayBuffer())
            })()
        return new Response(audioBytes.buffer as ArrayBuffer, { headers: { 'Content-Type': request.response_format === 'wav' ? 'audio/wav' : 'audio/mpeg' } })
      },
    }),
  }
}

function createAlibabaCloudConfigSchema(t: ProviderTranslator) {
  return alibabaCloudConfigSchema.extend({
    apiKey: alibabaCloudConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: alibabaCloudConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  })
}

function validateUnspeechConfig(config: UnspeechConfig, requireAppId = false, requireTrailingSlash = true) {
  const errors: Array<{ error: unknown }> = []
  const apiKey = config.apiKey?.trim() ?? ''
  const baseUrl = config.baseUrl?.trim() ?? ''

  if (!apiKey)
    errors.push({ error: new Error('API key is required.') })
  if (!baseUrl)
    errors.push({ error: new Error('Base URL is required.') })

  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      if (!url.host)
        errors.push({ error: new Error('Base URL is not absolute. Try to include a scheme (http:// or https://).') })
      else if (requireTrailingSlash && !baseUrl.endsWith('/'))
        errors.push({ error: new Error('Base URL must end with a trailing slash (/).') })
    }
    catch {
      errors.push({ error: new Error('Base URL is not absolute. Try to include a scheme (http:// or https://).') })
    }
  }

  if (requireAppId) {
    const appId = 'app' in config && config.app && typeof config.app === 'object' && 'appId' in config.app
      ? String(config.app.appId).trim()
      : ''
    if (!appId)
      errors.push({ error: new Error('App ID is required.') })
  }

  return {
    errors,
    reason: errors.map(item => (item.error as Error).message).join(', '),
    reasonKey: '',
    valid: errors.length === 0,
  }
}

function createUnspeechValidators<TConfig extends UnspeechConfig>(id: string, requireAppId = false) {
  return {
    validateConfig: [
      ({ t }: ProviderContext) => ({
        id: `${id}:check-config`,
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config: TConfig) => validateUnspeechConfig(config, requireAppId),
      }),
    ],
  }
}

export const providerDeepgramTts = defineProvider<UnspeechConfig, 'deepgram-tts'>({
  id: 'deepgram-tts',
  name: 'Deepgram',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.deepgram-tts.title'),
  description: 'deepgram.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.deepgram-tts.description'),
  tasks: ['text-to-speech'],
  icon: 'i-simple-icons:deepgram',
  createProviderConfig: ({ t }) => createUnspeechConfigSchema(unspeechConfigSchema, t),
  createProvider: config => createUnDeepgram(config.apiKey.trim(), config.baseUrl?.trim() ?? ''),
  validationRequiredWhen: config => Boolean(config.apiKey?.trim() && config.baseUrl?.trim()),
  validators: createUnspeechValidators('deepgram-tts'),
  extraMethods: {
    listModels: async () => [
      { id: 'aura-2', name: 'Aura 2', provider: 'deepgram-tts', description: 'Latest generation Aura model', deprecated: false },
      { id: 'aura-1', name: 'Aura 1', provider: 'deepgram-tts', description: 'First generation Aura model', deprecated: false },
      { id: 'aura', name: 'Aura (Legacy)', provider: 'deepgram-tts', description: 'Original Aura model', deprecated: true },
    ],
    voiceCatalogConfig: ({ apiKey, baseUrl }) => ({ apiKey, baseUrl }),
    listVoices: async (config) => {
      const provider = createUnDeepgram(config.apiKey.trim(), config.baseUrl?.trim() ?? '') as VoiceProviderWithExtraOptions<UnDeepgramOptions>
      const voices = await listVoices(toListVoicesOptions(provider))
      return voices.map(voice => ({
        id: voice.id,
        name: voice.name,
        provider: 'deepgram-tts',
        description: voice.description,
        languages: voice.languages,
        gender: voice.labels?.gender,
      }))
    },
  },
})

export const providerMicrosoftSpeech = defineProvider<MicrosoftSpeechConfig, 'microsoft-speech'>({
  id: 'microsoft-speech',
  name: 'Microsoft / Azure Speech',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.microsoft-speech.title'),
  description: 'speech.microsoft.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.microsoft-speech.description'),
  tasks: ['text-to-speech'],
  iconColor: 'i-lobe-icons:microsoft',
  createProviderConfig: ({ t }) => createUnspeechConfigSchema(microsoftSpeechConfigSchema, t),
  createProvider: config => createUnMicrosoft(config.apiKey.trim(), config.baseUrl?.trim() ?? ''),
  validationRequiredWhen: config => Boolean(config.apiKey?.trim() && config.baseUrl?.trim()),
  validators: createUnspeechValidators('microsoft-speech'),
  extraMethods: {
    listModels: async () => [{ id: 'v1', name: 'v1', provider: 'microsoft-speech', description: '', deprecated: false }],
    voiceCatalogConfig: ({ apiKey, baseUrl, region }) => ({ apiKey, baseUrl, region }),
    listVoices: async (config) => {
      const provider = createUnMicrosoft(config.apiKey.trim(), config.baseUrl?.trim() ?? '') as VoiceProviderWithExtraOptions<UnMicrosoftOptions>
      const voices = await listVoices(toListVoicesOptions(provider, { region: config.region ?? '' }))
      return voices.map(voice => ({
        id: voice.id,
        name: voice.name,
        provider: 'microsoft-speech',
        previewURL: voice.preview_audio_url,
        languages: voice.languages,
        gender: voice.labels?.gender,
      }))
    },
  },
})

export const providerAlibabaCloudModelStudio = defineProvider<AlibabaCloudConfig, 'alibaba-cloud-model-studio'>({
  id: 'alibaba-cloud-model-studio',
  name: 'Alibaba Cloud Model Studio',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.alibaba-cloud-model-studio.title'),
  description: 'bailian.console.aliyun.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.alibaba-cloud-model-studio.description'),
  tasks: ['text-to-speech'],
  iconColor: 'i-lobe-icons:alibabacloud',
  createProviderConfig: ({ t }) => createAlibabaCloudConfigSchema(t),
  createProvider: config => createAlibabaCloudNative(config.apiKey.trim(), config.baseUrl?.trim() || 'https://ws-ntfc49ta9az8bvz7.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'),
  validationRequiredWhen: config => Boolean(config.apiKey?.trim() && config.baseUrl?.trim()),
  validators: {
    validateConfig: [
      ({ t }: ProviderContext) => ({
        id: 'alibaba-cloud-model-studio:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config: AlibabaCloudConfig) => validateUnspeechConfig(config, false, false),
      }),
    ],
  },
  extraMethods: {
    listModels: async () => [
      { id: 'cosyvoice-v3.5-plus', name: 'CosyVoice 3.5 Plus', provider: 'alibaba-cloud-model-studio', description: '', deprecated: false },
      { id: 'cosyvoice-v3.5-flash', name: 'CosyVoice 3.5 Flash', provider: 'alibaba-cloud-model-studio', description: '', deprecated: false },
    ],
    voiceCatalogConfig: () => ({ apiKey: '', baseUrl: '' }),
    listVoices: async () => [{
      id: ALIBABA_CLONED_VOICE,
      name: 'Server clone',
      provider: 'alibaba-cloud-model-studio',
      compatibleModels: [ALIBABA_DEFAULT_MODEL],
      languages: [{ code: 'zh', title: 'Chinese' }],
      gender: 'neutral',
    }],
  },
})

export const providerVolcengineSpeech = defineProvider<VolcengineSpeechConfig, 'volcengine'>({
  id: 'volcengine',
  name: 'Volcengine',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.volcengine.title'),
  description: 'volcengine.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.volcengine.description'),
  tasks: ['text-to-speech'],
  iconColor: 'i-lobe-icons:volcengine',
  createProviderConfig: ({ t }) => createUnspeechConfigSchema(volcengineSpeechConfigSchema, t),
  createProvider: config => createUnVolcengine(config.apiKey.trim(), config.baseUrl?.trim() ?? ''),
  validationRequiredWhen: config => Boolean(config.apiKey?.trim() && config.baseUrl?.trim() && config.app?.appId.trim()),
  validators: createUnspeechValidators<VolcengineSpeechConfig>('volcengine', true),
  extraMethods: {
    listModels: async () => [{ id: 'v1', name: 'v1', provider: 'volcano-engine', description: '', deprecated: false }],
    voiceCatalogConfig: ({ apiKey, baseUrl }) => ({ apiKey, baseUrl }),
    listVoices: async (config) => {
      const provider = createUnVolcengine(config.apiKey.trim(), config.baseUrl?.trim() ?? '') as VoiceProviderWithExtraOptions<UnVolcengineOptions>
      const voices = await listVoices(toListVoicesOptions(provider))
      return voices.map(voice => ({
        id: voice.id,
        name: voice.name,
        provider: 'volcano-engine',
        previewURL: voice.preview_audio_url,
        languages: voice.languages,
        gender: voice.labels?.gender,
      }))
    },
  },
})
