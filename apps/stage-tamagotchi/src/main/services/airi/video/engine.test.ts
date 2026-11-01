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

  it('takes a new binary after construction, so the path can be set without a restart', () => {
    const movable = createVideoEngine({ cacheDir: 'test-cache' })
    movable.setFfmpegPath('C:/tools/ffmpeg/bin/ffmpeg.exe')
    expect(movable.capabilities()).toMatchObject({ ffmpegPath: 'C:/tools/ffmpeg/bin/ffmpeg.exe', available: true })

    // Clearing it falls back to the environment and PATH rather than keeping the stale choice.
    movable.setFfmpegPath('')
    expect(movable.capabilities().ffmpegPath).not.toBe('C:/tools/ffmpeg/bin/ffmpeg.exe')
  })
})
