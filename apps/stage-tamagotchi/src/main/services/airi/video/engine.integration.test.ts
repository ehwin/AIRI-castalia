import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { createVideoEngine } from './engine'

/**
 * The real path, against a real bilibili link: download, mux, probe, and one sheet.
 *
 * Opt-in, because it needs the network and ffmpeg on the machine:
 * `AIRI_VIDEO_E2E=1 npx vitest run src/main/services/airi/video/engine.integration.test.ts`
 */
describe.skipIf(!process.env.AIRI_VIDEO_E2E)('video engine, end to end', () => {
  const engine = createVideoEngine({ cacheDir: 'D:/AI/hermes-home/cache/scratch/vidcache' })

  it('probes, reads and draws one sheet of a bilibili clip', async () => {
    const probe = await engine.probe('BV1a5sZ6LEN3')
    expect('error' in probe).toBe(false)
    if ('error' in probe)
      return

    expect(probe.durationSeconds).toBeGreaterThan(60)
    expect(probe.width).toBeGreaterThan(0)

    const text = await engine.text('BV1a5sZ6LEN3')
    // Without a login cookie most videos expose no captions; the honest answer is an error.
    expect('error' in text || text.lines > 0).toBe(true)

    const sheet = await engine.sheet('BV1a5sZ6LEN3', { cells: 9 })
    expect('error' in sheet).toBe(false)
    if ('error' in sheet)
      return

    expect(sheet.width).toBeGreaterThan(1000)
    expect(sheet.cells).toHaveLength(9)
    expect(sheet.imageDataUrl.startsWith('data:image/png;base64,')).toBe(true)
  }, 180_000)

  /**
   * The signed caption read, against the real site and a real login.
   *
   * Measured 2026-11-03: the unsigned endpoint answered this clip with another video's captions.
   * This case fails if the engine goes back to the unsigned call, or if the returned cues are not
   * this clip's own (a foreign list runs past the clip's 349 s).
   *
   * Opt-in, because it needs a login cookie:
   * `AIRI_VIDEO_E2E=1 AIRI_BILI_COOKIE='SESSDATA=…' npx vitest run <this file>`
   */
  it.skipIf(!process.env.AIRI_BILI_COOKIE)('reads this clip\'s own captions, signed', async () => {
    const cookie = process.env.AIRI_BILI_COOKIE as string
    const probe = await engine.probe('BV1a5sZ6LEN3', { cookie })
    expect('error' in probe).toBe(false)
    if ('error' in probe)
      return

    const text = await engine.text('BV1a5sZ6LEN3', { cookie })
    expect('error' in text).toBe(false)
    if ('error' in text)
      return

    expect(text.origin).toBe('platform')
    expect(text.lines).toBeGreaterThan(50)
    const last = text.text.trimEnd().split('\n').at(-1) ?? ''
    const [minutes, seconds] = (last.match(/^\[(\d+):(\d+)\]/) ?? ['', '0', '0']).slice(1).map(Number)
    expect(minutes * 60 + seconds).toBeLessThanOrEqual(Math.round(probe.durationSeconds) + 60)
  }, 180_000)
})
