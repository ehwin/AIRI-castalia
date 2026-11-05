import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  bilibiliCuesToLines,
  createVideoEngine,
  pickSpriteCells,
  spriteFilterGraph,
  srtToLines,
  timestampOf,
} from './engine'

const engine = createVideoEngine({
  // A directory that never fills the disk in tests, and binaries that never run.
  cacheDir: 'test-cache',
  ffmpegPath: 'ffmpeg-not-installed',
  ffprobePath: 'ffprobe-not-installed',
})

/** What `x/player/videoshot` answers for a 349 s clip: 10x10 cells of 480x270, 43 of them timed. */
const sprite = {
  columns: 10,
  rows: 10,
  cellWidth: 480,
  cellHeight: 270,
  seconds: Array.from({ length: 43 }, (_, index) => index * 8),
}

describe('video engine', () => {
  it('formats a timestamp as the reply quotes it', () => {
    expect(timestampOf(0)).toBe('00:00')
    expect(timestampOf(61.4)).toBe('01:01')
    expect(timestampOf(3599)).toBe('59:59')
  })

  it('reads srt cues as `[mm:ss] text` and drops the formatting', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,200',
      '<i>Hello</i> there.',
      '',
      '2',
      '00:01:05,500 --> 00:01:09,000',
      'A second',
      'line.',
      '',
      '3',
      '00:02:00,000 --> 00:02:01,000',
      '   ',
      '',
    ].join('\n')

    expect(srtToLines(srt)).toEqual([
      '[00:01] Hello there.',
      '[01:05] A second line.',
    ])
  })

  it('reads bilibili captions as the same rows', () => {
    expect(bilibiliCuesToLines([
      { from: 0.4, content: '开场白' },
      { from: 12.2, content: '  第二句  ' },
      { from: 20, content: '' },
    ])).toEqual(['[00:00] 开场白', '[00:12] 第二句'])
  })

  it('maps sprite cells to the platform timecode, not an interpolation', () => {
    const picked = pickSpriteCells(sprite, { fromSeconds: 0, toSeconds: 344 }, 4)

    expect(picked).toHaveLength(4)
    expect(picked[0]).toMatchObject({ index: 0, atSeconds: 0, x: 0, y: 0 })
    expect(picked[3]!.index).toBe(42)
    // Cell 42 of a 10-wide grid is the third column of the fifth row.
    expect(picked[3]).toMatchObject({ x: 2 * 480, y: 4 * 270, atSeconds: 336 })
  })

  it('keeps the window when one is given', () => {
    const picked = pickSpriteCells(sprite, { fromSeconds: 80, toSeconds: 160 }, 3)
    expect(picked.map(cell => cell.atSeconds)).toEqual([80, 120, 160])
  })

  it('builds one filter graph for the whole sheet', () => {
    const graph = spriteFilterGraph(
      [{ x: 0, y: 0 }, { x: 480, y: 0 }, { x: 960, y: 0 }, { x: 0, y: 270 }],
      { width: 480, height: 270 },
      2,
    )

    expect(graph).toContain('[0:v]split=4[s0][s1][s2][s3]')
    expect(graph).toContain('[s2]crop=480:270:960:0[c2]')
    expect(graph).toContain('[c0][c1]hstack=2[r0]')
    expect(graph).toContain('[r0][r1]vstack=2[sheet]')
  })

  it('reports why a source could not be read instead of throwing', async () => {
    const result = await engine.probe('C:/definitely/not/here.mp4')
    expect('error' in result && result.error.length > 0).toBe(true)
  })

  it('reports an empty sprite as unreadable rather than drawing a blank sheet', () => {
    expect(pickSpriteCells({ ...sprite, seconds: [] }, { fromSeconds: 0, toSeconds: 10 }, 9)).toEqual([])
  })

  it('reports what this build can decode, so the settings page can explain a missing ffmpeg', () => {
    const capabilities = engine.capabilities()
    expect(capabilities).toMatchObject({ ffmpegPath: 'ffmpeg-not-installed', cacheDir: 'test-cache' })
    expect(capabilities.available).toBe(true)
  })

  it('prefers the copy that ships with the app over PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'airi-ffmpeg-'))
    await writeFile(join(dir, 'ffmpeg.exe'), 'not really a binary')
    await writeFile(join(dir, 'ffprobe.exe'), 'not really a binary')

    const packaged = createVideoEngine({ cacheDir: 'test-cache', bundledDir: dir })
    const capabilities = packaged.capabilities()

    expect(capabilities.ffmpegSource).toBe('bundled')
    expect(capabilities.ffmpegPath).toBe(join(dir, 'ffmpeg.exe'))
    expect(capabilities.available).toBe(true)

    // A path set in the settings still wins: the owner's choice is not silently overridden.
    packaged.setFfmpegPath('C:/elsewhere/ffmpeg.exe')
    expect(packaged.capabilities().ffmpegSource).toBe('setting')

    await rm(dir, { recursive: true, force: true })
  })

  it('takes a new binary after construction, so the path can be set without a restart', () => {
    const movable = createVideoEngine({ cacheDir: 'test-cache' })
    movable.setFfmpegPath('C:/tools/ffmpeg/bin/ffmpeg.exe')
    expect(movable.capabilities()).toMatchObject({ ffmpegPath: 'C:/tools/ffmpeg/bin/ffmpeg.exe', available: true })

    // Clearing it falls back to the environment and PATH rather than keeping the stale choice.
    movable.setFfmpegPath('')
    expect(movable.capabilities().ffmpegPath).not.toBe('C:/tools/ffmpeg/bin/ffmpeg.exe')
  })
})

/**
 * The caption path, against a fake bilibili.
 *
 * Measured 2026-11-03: the unsigned `x/player/v2` answered one clip with another video's captions,
 * so these tests pin the signed request and the refusal that keeps a foreign transcript out of a
 * reply.
 */
describe('video engine captions', () => {
  const clip = { bvid: 'BV1a5sZ6LEN3', cid: 431_460_198_18, title: '大肥鱼怎么知道第37分钟发生了什么？', duration: 349 }
  const wbi = {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  }

  function fakeBilibili(cues: Array<{ from: number, content: string, to?: number }>) {
    const requests: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      const json = (body: unknown) => ({ ok: true, json: async () => body })
      if (url.includes('/x/web-interface/nav'))
        return json({ code: 0, data: wbi })
      if (url.includes('/x/web-interface/view'))
        return json({ code: 0, data: { ...clip, dimension: { width: 1920, height: 1080 } } })
      if (url.includes('/x/player/'))
        return json({ code: 0, data: { subtitle: { subtitles: [{ subtitle_url: '//aisubtitle.example/zh.json' }] } } })
      if (url.includes('aisubtitle.example'))
        return json({ body: cues })
      throw new Error(`unexpected request ${url}`)
    }) as unknown as typeof fetch
    return { fetchImpl, requests }
  }

  const engineWith = (fetchImpl: typeof fetch) => createVideoEngine({ cacheDir: 'test-cache', ffmpegPath: 'ffmpeg-not-installed', fetchImpl })

  it('signs the caption request, because the unsigned endpoint answers with another clip', async () => {
    const { fetchImpl, requests } = fakeBilibili([{ from: 0, content: '一部90分钟的片子', to: 12 }])
    const result = await engineWith(fetchImpl).text(clip.bvid)

    expect('error' in result).toBe(false)
    if ('error' in result)
      return
    expect(result.lines).toBe(1)
    expect(result.origin).toBe('platform')

    const player = requests.find(url => url.includes('/x/player/'))
    expect(player).toContain('/x/player/wbi/v2?')
    expect(player).toContain('w_rid=')
    expect(player).toContain('wts=')
    expect(player).not.toContain('/x/player/v2?')
  })

  it('refuses captions that run past the clip instead of quoting another video', async () => {
    const { fetchImpl } = fakeBilibili([{ from: 0, content: '呵呵哈哈喽哈喽', to: 836 }])
    const result = await engineWith(fetchImpl).text(clip.bvid)

    expect('error' in result).toBe(true)
    if (!('error' in result))
      return
    expect(result.error).toContain('another clip')
    expect(result.error).toContain('349')
  })

  it('does not blame a missing cookie when the cookie was sent', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) => ({ ok: true, json: async () => body })
      if (url.includes('/x/web-interface/nav'))
        return json({ code: 0, data: wbi })
      if (url.includes('/x/web-interface/view'))
        return json({ code: 0, data: { ...clip, dimension: { width: 1920, height: 1080 } } })
      return json({ code: 0, data: { subtitle: { subtitles: [] } } })
    }) as unknown as typeof fetch

    const result = await engineWith(fetchImpl).text(clip.bvid, { cookie: 'SESSDATA=abc' })
    expect('error' in result).toBe(true)
    if (!('error' in result))
      return
    expect(result.error).toContain('even with the cookie')
    expect(result.error).not.toContain('Fill the bilibili cookie')
  })
})
