import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { generateSpeech } from '@xsai/generate-speech'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerAlibabaCloudModelStudio } from './index'

const endpoint = 'https://ws-ntfc49ta9az8bvz7.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const model = 'cosyvoice-v3.5-plus'
const voice = 'cosyvoice-v3.5-plus-bailian-48f9e6aa815148158d6f8a8630dc24d4'
const config = { apiKey: 'test-only', baseUrl: endpoint }

// Exercise the same package export that the desktop bundler consumes. The `.mjs` extension is
// deliberate: this loads the built bundle, not the TypeScript source.
// eslint-disable-next-line no-restricted-syntax
const built = await import('../../../../dist/index.mjs')
const definitions = [
  ['source', providerAlibabaCloudModelStudio],
  ['package export', built.getDefinedProvider('alibaba-cloud-model-studio')!],
] as const

afterEach(() => vi.unstubAllGlobals())

for (const [name, definition] of definitions) {
  describe(`Alibaba ${name}`, () => {
    it('loads the server clone without any catalog HTTP request', async () => {
      const network = vi.fn(async () => new Response(JSON.stringify({ code: 'BadRequest.EmptyModel', message: 'Required parameter "model" missing from request.' }), { status: 400 }))
      vi.stubGlobal('fetch', network)
      const provider = await definition.createProvider(config)
      const voices = await definition.extraMethods!.listVoices!(config, provider, model)
      expect(voices.map((item: { id: string }) => item.id)).toContain(voice)
      expect(network).not.toHaveBeenCalled()
    })

    it('uses the native bridge when present and downloads audio', async () => {
      const bridge = vi.fn(async (_endpoint: string, _apiKey: string, _body: string) => new Uint8Array([73, 68, 51]))
      vi.stubGlobal('api', { bailianSpeechSynthesize: bridge })
      const network = vi.fn(async () => Response.json({ output: { audio: { url: 'https://audio.example/test.mp3' } } }))
      vi.stubGlobal('fetch', network)
      const provider = await definition.createProvider(config) as SpeechProviderWithExtraOptions<string, Record<string, unknown>>
      const audio = await generateSpeech({ ...provider.speech(model), input: '你好', voice })
      expect(Array.from(new Uint8Array(audio))).toEqual([73, 68, 51])
      expect(bridge).toHaveBeenCalledOnce()
      expect(bridge.mock.calls[0][0]).toBe(endpoint)
      expect(JSON.parse(bridge.mock.calls[0][2])).toMatchObject({ model, input: { text: '你好', voice } })
      expect(network).not.toHaveBeenCalled()
    })

    it('synthesizes through direct fetch when no desktop bridge exists', async () => {
      const network = vi.fn()
        .mockResolvedValueOnce(Response.json({ output: { audio: { url: 'https://audio.example/test.mp3' } } }))
        .mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51])))
      vi.stubGlobal('fetch', network)
      const provider = await definition.createProvider(config) as SpeechProviderWithExtraOptions<string, Record<string, unknown>>
      const audio = await generateSpeech({ ...provider.speech(model), input: '你好', voice })
      expect(Array.from(new Uint8Array(audio))).toEqual([73, 68, 51])
      expect(network).toHaveBeenCalledTimes(2)
      expect(network.mock.calls[0][0]).toBe(endpoint)
      expect(network.mock.calls[0][1].method).toBe('POST')
      expect(JSON.parse(network.mock.calls[0][1].body)).toMatchObject({ model, input: { text: '你好', voice } })
      expect(network.mock.calls[1][0]).toBe('https://audio.example/test.mp3')
    })
  })
}
