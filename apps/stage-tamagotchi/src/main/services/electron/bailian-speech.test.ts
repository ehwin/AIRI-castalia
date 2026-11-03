import { beforeEach, describe, expect, it, vi } from 'vitest'

const handle = vi.fn()
vi.mock('electron', () => ({ ipcMain: { handle } }))

const { synthesizeBailian } = await import('./bailian-speech')
const endpoint = 'https://test.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'

beforeEach(() => handle.mockClear())

describe('synthesizeBailian', () => {
  it('posts to the native endpoint and returns downloaded audio bytes', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ output: { audio: { url: 'http://audio.aliyuncs.com/test.mp3' } } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([73, 68, 51])))
    const result = await synthesizeBailian(endpoint, 'test-key', '{"model":"m","input":{"text":"hi"}}', request as typeof fetch)
    expect(Array.from(result)).toEqual([73, 68, 51])
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer test-key' } })
    expect(new URL(String(request.mock.calls[1][0])).href).toBe('https://audio.aliyuncs.com/test.mp3')
  })

  it('rejects endpoints outside the configured Bailian resource', async () => {
    const request = vi.fn()
    await expect(synthesizeBailian('https://example.com/tts', 'key', '{}', request as typeof fetch)).rejects.toThrow('Unsupported Bailian speech endpoint')
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects audio URLs outside Aliyun', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ output: { audio: { url: 'https://evil.example/audio.mp3' } } }))
    await expect(synthesizeBailian(endpoint, 'key', '{}', request as typeof fetch)).rejects.toThrow('Unsupported Bailian audio URL')
    expect(request).toHaveBeenCalledTimes(1)
  })

  // The account allows three cosyvoice requests per second; the fourth of one burst is rejected in ~0.25 s and the
  // reply loses every later segment, so the retry is what keeps a long answer audible.
  it('waits out a rate-quota rejection before the segment is dropped', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('{"code":"Throttling.RateQuota"}', { status: 429 }))
      .mockResolvedValueOnce(Response.json({ output: { audio: { url: 'https://audio.aliyuncs.com/after-retry.mp3' } } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
    const result = await synthesizeBailian(endpoint, 'key', '{}', request as typeof fetch)
    expect(Array.from(result)).toEqual([1, 2, 3])
    expect(request).toHaveBeenCalledTimes(3)
    expect(new URL(String(request.mock.calls[2][0])).href).toBe('https://audio.aliyuncs.com/after-retry.mp3')
  })

  it('gives up after the retry budget and reports the last rejection', async () => {
    const request = vi.fn().mockImplementation(async () => new Response('{"code":"Throttling.RateQuota"}', { status: 429 }))
    await expect(synthesizeBailian(endpoint, 'key', '{}', request as typeof fetch)).rejects.toThrow('Bailian synthesis 429')
    // One first attempt and two retries, then the segment is a failure rather than a silent hang.
    expect(request).toHaveBeenCalledTimes(3)
  }, 10000)

  it('does not retry a request the endpoint rejects outright', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"code":"InvalidParameter"}', { status: 400 }))
    await expect(synthesizeBailian(endpoint, 'key', '{}', request as typeof fetch)).rejects.toThrow('Bailian synthesis 400')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stops waiting for a retry when the renderer interrupts', async () => {
    const cancelled = new AbortController()
    const request = vi.fn().mockImplementation(async () => {
      setTimeout(() => cancelled.abort(new Error('Cancelled by the renderer')), 100)
      return new Response('{"code":"Throttling.RateQuota"}', { status: 429 })
    })
    await expect(synthesizeBailian(endpoint, 'key', '{}', request as typeof fetch, cancelled.signal)).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  }, 10000)
})
