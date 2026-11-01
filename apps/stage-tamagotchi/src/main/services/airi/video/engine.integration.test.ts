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
})
