import { afterEach, describe, expect, it, vi } from 'vitest'

import { isNpuWhisperReachable, NPU_WHISPER_BASE_URL } from './npu-whisper'

describe('isNpuWhisperReachable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts an OpenAI-style model list', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'Whisper-Small' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(isNpuWhisperReachable()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(`${NPU_WHISPER_BASE_URL}models`, expect.anything())
  })

  it('rejects a server that is not serving models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))

    await expect(isNpuWhisperReachable()).resolves.toBe(false)
  })

  it('treats a connection failure as unreachable instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))

    await expect(isNpuWhisperReachable()).resolves.toBe(false)
  })

  it('treats a non-list body as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 200 })))

    await expect(isNpuWhisperReachable()).resolves.toBe(false)
  })
})
