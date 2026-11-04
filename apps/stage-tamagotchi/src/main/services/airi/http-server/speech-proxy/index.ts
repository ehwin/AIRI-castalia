import type { ServerManager } from '../server-manager/types'

import { networkInterfaces } from 'node:os'

import { errorMessageFrom } from '@moeru/std'
import { H3 } from 'h3'

import { synthesizeBailian } from '../../../electron/bailian-speech'
import { createH3Server } from '../server'

/** The endpoint the provider ships as its default; a caller can override it with `X-Bailian-Endpoint`. */
const DEFAULT_BAILIAN_ENDPOINT = 'https://ws-ntfc49ta9az8bvz7.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const DEFAULT_BAILIAN_MODEL = 'cosyvoice-v3.5-plus'
const DEFAULT_BAILIAN_VOICE = 'cosyvoice-v3.5-plus-bailian-48f9e6aa815148158d6f8a8630dc24d4'
const MAX_SPEECH_TEXT_LENGTH = 2000

/**
 * Bailian's TTS endpoint sends no `Access-Control-Allow-Origin`, so a browser renderer cannot call it
 * directly: the phone WebView gets `TypeError: Failed to fetch` while the desktop main process succeeds.
 * The proxy answers the OpenAI-compatible path the speech client already builds, and relays the request
 * from main, where CORS does not apply.
 */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bailian-Endpoint',
  'Access-Control-Max-Age': '600',
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/**
 * A provider client may spell the model as `<vendor>/<model>`; Bailian only accepts the bare name.
 * The older pocket bundle always sends `alibaba/cosyvoice-v3.5-plus`, which fails with `Model not exist`.
 */
function bareModelName(model: string) {
  const slash = model.lastIndexOf('/')
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model
}

function lanBaseUrl(port: number): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal)
        return `http://${address.address}:${port}`
    }
  }
  return undefined
}

export interface SpeechProxyService extends ServerManager {
  getBaseUrl: () => string | undefined
}

/**
 * Creates the LAN speech proxy that lets a browser-side stage speak with the desktop's Bailian voice.
 *
 * Use when:
 * - A phone or another LAN renderer must synthesize speech without its own native transport
 *
 * Expects:
 * - The caller sends its own `Authorization: Bearer <apiKey>`
 * - `POST /v1/audio/speech` with an OpenAI-compatible speech body
 *
 * Returns:
 * - Lifecycle service plus the local base URL the caller's provider `baseUrl` must point at
 */
export function createSpeechProxyService(options?: {
  host?: string
  port?: number
  endpoint?: string
}): SpeechProxyService {
  const host = options?.host ?? '0.0.0.0'
  const port = options?.port ?? 6199

  const app = new H3()
  const lifecycle = createH3Server({ app, host, port })

  app.use('/**', (event) => {
    if (event.req.method !== 'OPTIONS')
      return undefined
    return new Response(null, { status: 204, headers: corsHeaders })
  })

  app.use('/v1/audio/speech', async (event) => {
    if (event.req.method !== 'POST')
      return jsonResponse({ error: 'Method Not Allowed' }, 405)

    const apiKey = (event.req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    if (!apiKey)
      return jsonResponse({ error: 'Missing Authorization bearer token' }, 401)

    let payload: { model?: unknown, input?: unknown, voice?: unknown, response_format?: unknown }
    try {
      payload = await event.req.json() as typeof payload
    }
    catch {
      return jsonResponse({ error: 'Request body must be JSON' }, 400)
    }

    const text = typeof payload.input === 'string' ? payload.input.trim() : ''
    if (!text)
      return jsonResponse({ error: 'input must be a non-empty string' }, 400)
    if (text.length > MAX_SPEECH_TEXT_LENGTH)
      return jsonResponse({ error: `input must be ${MAX_SPEECH_TEXT_LENGTH} characters or fewer` }, 400)

    const format = payload.response_format === 'wav' ? 'wav' : 'mp3'
    const voice = typeof payload.voice === 'string' && payload.voice.trim() ? payload.voice.trim() : DEFAULT_BAILIAN_VOICE
    const model = typeof payload.model === 'string' && payload.model.trim() ? bareModelName(payload.model.trim()) : DEFAULT_BAILIAN_MODEL
    const endpoint = event.req.headers.get('x-bailian-endpoint')?.trim() || options?.endpoint || DEFAULT_BAILIAN_ENDPOINT

    try {
      const audio = await synthesizeBailian(endpoint, apiKey, JSON.stringify({
        model,
        input: { text, voice, format, sample_rate: 24000 },
      }))
      return new Response(audio, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg',
          'Cache-Control': 'no-store',
        },
      })
    }
    catch (error) {
      return jsonResponse({ error: errorMessageFrom(error) ?? 'Speech synthesis failed' }, 502)
    }
  })

  return {
    key: 'speech-proxy',
    getBaseUrl: () => lanBaseUrl(port),
    start: async () => {
      const address = await lifecycle.start()
      // The caller has to paste this into its provider settings, so it must stay visible.
      console.info(`[AIRI] speech proxy listening on ${address.baseUrl} (use ${lanBaseUrl(port)} from another device)`)
    },
    stop: async () => {
      await lifecycle.stop()
    },
  }
}
