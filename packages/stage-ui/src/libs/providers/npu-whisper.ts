import type { TranscriptionProvider } from '@xsai-ext/providers/utils'

import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { watch } from 'vue'

import { useHearingStore } from '../../stores/modules/hearing'
import { useProviderConfigStore } from '../../stores/providers/config'

/**
 * OpenAI-compatible transcription provider that AIRI already ships. Zero code
 * duplication: a local server that speaks the OpenAI audio API plugs in here.
 */
export const NPU_WHISPER_PROVIDER_ID = 'openai-compatible-audio-transcription'

/** Lemonade Server on this machine; the provider appends `audio/transcriptions`. */
export const NPU_WHISPER_BASE_URL = 'http://127.0.0.1:13305/v1/'

/** whisper.cpp + Vitis AI encoder running on the AMD XDNA2 NPU. */
export const NPU_WHISPER_MODEL = 'Whisper-Small'

/** Any non-empty value satisfies the provider validator; the local server ignores it. */
const LOCAL_API_KEY = 'local'

/** Speech recognition of the local server is Chinese-first. */
const LOCAL_LANGUAGE = 'zh'

let applied = false

/**
 * Tells if Lemonade Server answers on this machine.
 *
 * Use when:
 * - Deciding whether the local NPU speech endpoint is worth selecting.
 *
 * Expects:
 * - `baseUrl` ends with `/` and serves `/models` (OpenAI list shape).
 *
 * Returns:
 * - `true` only when the server answered with a model list within `timeoutMs`.
 */
export async function isNpuWhisperReachable(baseUrl = NPU_WHISPER_BASE_URL, timeoutMs = 1500): Promise<boolean> {
  if (typeof fetch !== 'function')
    return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}models`, { signal: controller.signal })
    if (!response.ok)
      return false

    const body = await response.json() as { data?: unknown }
    return Array.isArray(body?.data)
  }
  catch {
    return false
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Asks the local server to load the transcription model.
 *
 * Use when:
 * - Voice input turns on after the model was evicted for being idle (~15 min).
 *
 * Expects:
 * - Lemonade Server on the same machine; a failure is not fatal, the next
 *   transcription request auto-loads the model instead.
 */
export async function warmNpuWhisper(baseUrl = NPU_WHISPER_BASE_URL): Promise<void> {
  if (typeof fetch !== 'function')
    return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    await fetch(`${baseUrl}load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: NPU_WHISPER_MODEL, whispercpp_backend: 'npu' }),
      signal: controller.signal,
    })
  }
  catch {
    // A cold model is a latency problem, never a correctness problem.
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Points voice input at the local NPU Whisper on first run.
 *
 * Use when:
 * - The desktop app starts and no transcription provider has been chosen yet, so
 *   the voice switch works out of the box instead of asking for an API key.
 *
 * Expects:
 * - Pinia is active (call after `app.use(pinia)`).
 * - The user's existing provider choice always wins: nothing is overwritten.
 *
 * Returns:
 * - A promise that resolves once seeding finished or was skipped.
 */
export async function applyNpuWhisperDefaults(): Promise<void> {
  if (applied)
    return
  applied = true

  if (!isStageTamagotchi())
    return

  if (!await isNpuWhisperReachable())
    return

  const providerStore = useProviderConfigStore()
  const hearingStore = useHearingStore()

  const existing = providerStore.getProviderConfig(NPU_WHISPER_PROVIDER_ID)
  if (!existing) {
    providerStore.ensureProvider(NPU_WHISPER_PROVIDER_ID, NPU_WHISPER_PROVIDER_ID, {
      apiKey: LOCAL_API_KEY,
      baseUrl: NPU_WHISPER_BASE_URL,
      model: NPU_WHISPER_MODEL,
      language: LOCAL_LANGUAGE,
    })
    providerStore.markProviderAdded(NPU_WHISPER_PROVIDER_ID)
  }
  else {
    // Fill only the holes: a user who pointed this provider somewhere else keeps it.
    const patch: Record<string, unknown> = {}
    if (!existing.baseUrl)
      patch.baseUrl = NPU_WHISPER_BASE_URL
    if (!existing.apiKey)
      patch.apiKey = LOCAL_API_KEY
    if (!existing.model)
      patch.model = NPU_WHISPER_MODEL
    if (!existing.language)
      patch.language = LOCAL_LANGUAGE
    if (Object.keys(patch).length > 0)
      await providerStore.patchProviderConfig(NPU_WHISPER_PROVIDER_ID, patch)
  }

  providerStore.setProviderStatus(NPU_WHISPER_PROVIDER_ID, 'configured')

  if (!hearingStore.activeTranscriptionProvider) {
    hearingStore.activeTranscriptionProvider = NPU_WHISPER_PROVIDER_ID
    hearingStore.activeTranscriptionModel = NPU_WHISPER_MODEL
  }

  // The local model evicts itself after ~15 min idle; warming when the switch
  // turns on hides the reload behind the moment the user starts speaking.
  watch(() => hearingStore.enabled, (enabled) => {
    if (!enabled)
      return
    if (hearingStore.activeTranscriptionProvider !== NPU_WHISPER_PROVIDER_ID)
      return
    void warmNpuWhisper()
  }, { immediate: true })
}

/**
 * Transcribes one audio blob with the local NPU Whisper.
 *
 * Use when:
 * - A caller needs speech-to-text without going through the provider registry
 *   (for example a diagnostics panel or a benchmark script).
 *
 * Expects:
 * - `blob` is a browser `File`/`Blob` holding any format the server can decode.
 *
 * Returns:
 * - The recognized text, or an empty string when the server returned nothing.
 */
export async function transcribeWithNpuWhisper(blob: Blob, language = LOCAL_LANGUAGE): Promise<string> {
  const form = new FormData()
  form.append('file', blob, 'speech.wav')
  form.append('model', NPU_WHISPER_MODEL)
  form.append('language', language)
  form.append('response_format', 'json')

  const response = await fetch(`${NPU_WHISPER_BASE_URL}audio/transcriptions`, { method: 'POST', body: form })
  if (!response.ok)
    throw new Error(`Local NPU transcription failed: ${response.status} ${response.statusText}`)

  const body = await response.json() as { text?: string }
  return typeof body?.text === 'string' ? body.text.trim() : ''
}

/** Type-only re-export so callers do not need to reach into xsai for provider shapes. */
export type LocalTranscriptionProvider = TranscriptionProvider
