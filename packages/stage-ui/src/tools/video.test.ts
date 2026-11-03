import type { VideoToolRuntime } from './video'

import { describe, expect, it, vi } from 'vitest'

import {
  cellsForDepth,
  createVideoTools,
  defaultVideoBudget,
  timestampOfSeconds,
  VIDEO_OUTLINE_TOOL_NAME,
  VIDEO_PROBE_TOOL_NAME,
  VIDEO_REMEMBER_TOOL_NAME,
  VIDEO_STORYBOARD_TOOL_NAME,
  VIDEO_ZOOM_TOOL_NAME,
} from './video'

const call = { messages: [], toolCallId: 'video' }

function fakeRuntime(overrides: Partial<VideoToolRuntime> = {}): VideoToolRuntime {
  return {
    probe: vi.fn(async () => ({
      durationSeconds: 348.6,
      width: 852,
      height: 480,
      fps: 30,
      hasAudio: true,
      hasTextTrack: false,
      source: 'C:/cache/3d79/media.mp4',
      cached: true,
      title: 'a clip',
    })),
    text: vi.fn(async () => ({
      text: '[00:01] hello\n[00:09] a longer line',
      lines: 2,
      chars: 33,
      truncated: false,
      origin: 'platform' as const,
    })),
    sheet: vi.fn(async () => ({
      imageDataUrl: 'data:image/png;base64,AAAA',
      width: 1440,
      height: 1440,
      fromSeconds: 0,
      toSeconds: 348,
      cells: [
        { index: 1, atSeconds: 19.3 },
        { index: 2, atSeconds: 58 },
      ],
      path: 'C:/cache/3d79/sheet-ab.png',
      bytes: 480_509,
      cached: false,
    })),
    ...overrides,
  }
}

describe('video tools', () => {
  it('exposes four tools in the order the prompt teaches', async () => {
    const tools = await createVideoTools(fakeRuntime())
    expect(tools.map(tool => tool.function.name)).toEqual([
      VIDEO_PROBE_TOOL_NAME,
      VIDEO_OUTLINE_TOOL_NAME,
      VIDEO_STORYBOARD_TOOL_NAME,
      VIDEO_ZOOM_TOOL_NAME,
    ])
  })

  it('probes a source and returns the metadata as json', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime)
    const result = await tools[0]!.execute({ source: 'BV1a5sZ6LEN3' }, call)

    expect(runtime.probe).toHaveBeenCalledWith('BV1a5sZ6LEN3')
    expect(JSON.parse(String(result))).toMatchObject({ durationSeconds: 348.6, hasTextTrack: false })
  })

  it('reports why a video could not be read, instead of failing the turn', async () => {
    const tools = await createVideoTools(fakeRuntime({ probe: async () => ({ error: 'no such file' }) }))
    expect(await tools[0]!.execute({ source: 'nope.mp4' }, call)).toBe('Could not read that video: no such file')
  })

  it('reads the transcript and names its origin', async () => {
    const tools = await createVideoTools(fakeRuntime())
    const result = String(await tools[1]!.execute({ source: 'BV1', max_chars: null }, call))
    expect(result).toContain('platform, 2 rows')
    expect(result).toContain('[00:09] a longer line')
  })

  it('says plainly when a video has no transcript', async () => {
    const tools = await createVideoTools(fakeRuntime({
      text: async () => ({ error: 'this video has no text track. Read the picture with builtIn_videoStoryboard.' }),
    }))
    expect(String(await tools[1]!.execute({ source: 'BV1', max_chars: null }, call)))
      .toBe('No transcript: this video has no text track. Read the picture with builtIn_videoStoryboard.')
  })

  it('returns the sheet as a text index plus one image part', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime, { depth: () => 'deep' })
    const result = await tools[2]!.execute({ source: 'BV1', from_seconds: null, to_seconds: null, cells: null }, call) as unknown[]

    // The cell count falls back to the module depth, which is what the setting means.
    expect(runtime.sheet).toHaveBeenCalledWith({ source: 'BV1', fromSeconds: undefined, toSeconds: undefined, cells: cellsForDepth('deep') })
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'text' })
    expect(String((result[0] as { text: string }).text)).toContain('Cell timecodes: #1 00:19  #2 00:58')
    expect(result[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })
  })

  it('drops the picture but keeps the index when the sheet carries no image', async () => {
    const runtime = fakeRuntime({
      sheet: async () => ({
        imageDataUrl: '',
        width: 1440,
        height: 1440,
        fromSeconds: 0,
        toSeconds: 10,
        cells: [{ index: 1, atSeconds: 5 }],
        path: 'C:/cache/x.png',
        bytes: 1,
        cached: true,
      }),
    })
    const tools = await createVideoTools(runtime)
    const result = await tools[2]!.execute({ source: 'BV1', from_seconds: null, to_seconds: null, cells: 9 }, call)
    expect(typeof result).toBe('string')
    expect(String(result)).toContain('#1 00:05')
  })

  it('refuses an empty zoom window without asking the runtime', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime)
    expect(await tools[3]!.execute({ source: 'BV1', from_seconds: 30, to_seconds: 30, cells: null }, call))
      .toContain('The zoom window is empty')
    expect(runtime.sheet).not.toHaveBeenCalled()
  })

  it('stops one video from being redrawn and still lets another video draw', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime, {
      budget: { ...defaultVideoBudget, sheetsPerSource: 2, sheetsPerBurst: 9, sheetsPerHour: 99 },
    })
    const storyboard = tools[2]!
    const sheet = { source: 'BV1', from_seconds: null, to_seconds: null, cells: 9 }

    await storyboard.execute(sheet, call)
    await storyboard.execute(sheet, call)
    const refused = await storyboard.execute(sheet, call)
    expect(String(refused)).toContain('used up (2/2)')
    expect(runtime.sheet).toHaveBeenCalledTimes(2)

    // A different clip has its own budget, so a busy hour is not a locked door.
    expect(JSON.stringify(await storyboard.execute({ ...sheet, source: 'BV2' }, call))).toContain('Contact sheet')
    expect(runtime.sheet).toHaveBeenCalledTimes(3)
  })

  it('stops a burst of sheets drawn back to back', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime, {
      budget: { ...defaultVideoBudget, sheetsPerBurst: 2, sheetsPerHour: 99, sheetsPerSource: 99 },
    })
    const storyboard = tools[2]!
    const sheet = { source: 'BV1', from_seconds: null, to_seconds: null, cells: 9 }

    await storyboard.execute(sheet, call)
    await storyboard.execute({ ...sheet, source: 'BV2' }, call)
    expect(String(await storyboard.execute({ ...sheet, source: 'BV3' }, call))).toContain('back to back')
    expect(runtime.sheet).toHaveBeenCalledTimes(2)
  })

  it('caps zooms per video', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime, {
      budget: { ...defaultVideoBudget, zoomsPerSource: 1, zoomsPerBurst: 9, zoomsPerHour: 99 },
    })
    const zoom = tools[3]!
    await zoom.execute({ source: 'BV1', from_seconds: 10, to_seconds: 20, cells: 6 }, call)
    expect(String(await zoom.execute({ source: 'BV1', from_seconds: 10, to_seconds: 20, cells: 6 }, call)))
      .toContain('used up (1/1)')
    expect(runtime.sheet).toHaveBeenCalledTimes(1)
  })

  it('rejects a call with no source', async () => {
    const runtime = fakeRuntime()
    const tools = await createVideoTools(runtime)
    expect(await tools[0]!.execute({}, call)).toContain('`source` is required')
    expect(runtime.probe).not.toHaveBeenCalled()
  })

  it('formats the timecodes a reply has to quote', () => {
    expect(timestampOfSeconds(0)).toBe('00:00')
    expect(timestampOfSeconds(59.6)).toBe('00:59')
    expect(timestampOfSeconds(3725)).toBe('62:05')
  })
})

describe('video watchlist tool', () => {
  it('is not mounted when the shell has no queue to pick it up from', async () => {
    const tools = await createVideoTools(fakeRuntime())
    expect(tools.map(tool => tool.function.name)).not.toContain(VIDEO_REMEMBER_TOOL_NAME)
  })

  it('queues a clip with the reason she wrote', async () => {
    const enqueue = vi.fn(async () => ({ queued: 1, message: 'Queued for later (1 waiting).' }))
    const tools = await createVideoTools(fakeRuntime({
      watchlist: { enqueue, recall: async () => 'nothing' },
    }))

    const tool = tools.find(entry => entry.function.name === VIDEO_REMEMBER_TOOL_NAME)!
    expect(await tool.execute({ action: 'queue', source: 'BV1', why: '她的分镜算法值得看', limit: null }, call))
      .toBe('Queued for later (1 waiting).')
    expect(enqueue).toHaveBeenCalledWith({ source: 'BV1', why: '她的分镜算法值得看' })
  })

  it('refuses a queue call with no source', async () => {
    const enqueue = vi.fn()
    const tools = await createVideoTools(fakeRuntime({ watchlist: { enqueue, recall: async () => '' } }))
    const tool = tools.find(entry => entry.function.name === VIDEO_REMEMBER_TOOL_NAME)!

    expect(await tool.execute({ action: 'queue', source: null, why: 'x', limit: null }, call))
      .toContain('needs a source')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('reads back what she watched on her own', async () => {
    const recall = vi.fn(async () => '2026-11-01 22:10 — BV1 / why: 好奇')
    const tools = await createVideoTools(fakeRuntime({ watchlist: { enqueue: async () => ({ queued: 0, message: '' }), recall } }))
    const tool = tools.find(entry => entry.function.name === VIDEO_REMEMBER_TOOL_NAME)!

    expect(String(await tool.execute({ action: 'recall', source: null, why: null, limit: null }, call))).toContain('why: 好奇')
    expect(recall).toHaveBeenCalledWith(5)
  })
})
