import type { VideoProbe, VideoSheet, VideoTextTrack } from '@proj-airi/stage-ui/tools/video'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

/**
 * Reads a video for the chat without downloading it.
 *
 * The ladder, cheapest first. The order is the design, not an optimization:
 * 1. `text` reads captions: the platform's caption list for a bilibili link, an embedded subtitle
 *    stream for a local file. No media bytes, and the only part of a video that can be quoted.
 * 2. `sheet` over a whole clip uses the platform's own contact sheet: bilibili publishes a sprite
 *    of ~100 thumbnails with a timecode per cell, so one ~265 KB request covers the clip and a
 *    single ffmpeg crop turns it into one image. No video decode.
 * 3. `sheet` over a window (a zoom) seeks in the stream and decodes only that window, so 20 s of
 *    film costs 20 s of bytes.
 *
 * Measured 2026-11-01 on BV1a5sZ6LEN3 (349 s): `x/player/videoshot` answered with one 4800x2700
 * JPEG, 265 KB, 100 cells of 480x270, 43 of them carrying a timecode. The first version of this
 * file downloaded the whole 480p stream (7.4 MB, 4.8 s) to answer the same question.
 */

/** Options that the renderer owns, so one engine serves every chat window. */
export interface VideoEngineOptions {
  /** Directory for sprites and rendered sheets. The video itself is never kept. */
  cacheDir: string
  /** `ffmpeg` binary. Defaults to `AIRI_FFMPEG_PATH`, then `PATH`. */
  ffmpegPath?: string
  /** `ffprobe` binary. Defaults to `AIRI_FFPROBE_PATH`, then `PATH`. */
  ffprobePath?: string
  /**
   * Directory shipped inside the app, `<resources>/ffmpeg`, holding its own `ffmpeg` and `ffprobe`.
   *
   * A packaged install has to work on a machine that never installed ffmpeg: the binaries travel
   * with the app, and an explicit path (setting or environment) still wins over them.
   */
  bundledDir?: string
  /** Test seam. */
  fetchImpl?: typeof fetch
}

/** Every method answers with the result or with `{ error }`, which the tool layer shows as text. */
export interface VideoFailure { error: string }

export type VideoProbeResult = VideoProbe | VideoFailure
export type VideoTextResult = VideoTextTrack | VideoFailure
export type VideoSheetResult = VideoSheet | VideoFailure

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const BILIBILI_REFERER = 'https://www.bilibili.com'
/** A window longer than this is a whole-clip read, which the sprite path should serve instead. */
const MAX_DECODE_WINDOW_SECONDS = 300
const CELL_MAX_PX = 480
const SHEET_MAX_WIDTH = 1440
/** A cell narrower than this cannot be read for faces or small text. */
const CELL_MIN_PX = 240

/** `[mm:ss]` for a timestamp, which is the unit every reply must quote. Floors, as a player shows it. */
export function timestampOf(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Parses an SRT document into `[mm:ss] line` rows, one per cue. */
export function srtToLines(srt: string): string[] {
  const rows: string[] = []
  for (const block of srt.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean)
    const timeIndex = lines.findIndex(line => line.includes('-->'))
    if (timeIndex < 0)
      continue
    const start = lines[timeIndex]!.split('-->')[0]!.trim()
    const [hours, minutes, seconds] = start.split(':')
    const secondsTotal = Number(seconds?.replace(',', '.') ?? 0)
      + Number(minutes ?? 0) * 60
      + Number(hours ?? 0) * 3600
    const text = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    if (text)
      rows.push(`[${timestampOf(secondsTotal)}] ${text}`)
  }
  return rows
}

/** Bilibili captions arrive as `{ from, to, content }` cues. */
export function bilibiliCuesToLines(cues: Array<{ from: number, content: string }>): string[] {
  return cues
    .map(cue => `[${timestampOf(cue.from)}] ${cue.content.replace(/\s+/g, ' ').trim()}`)
    .filter(line => line.length > 8)
}

/** The grid geometry of a platform sprite, plus the timecode of each cell. */
export interface SpriteGeometry {
  /** Cells per row and per column, as the platform lays them out. */
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  /**
   * Seconds of each cell in reading order. A cell past the end of this list is unused, and a cell
   * without a timecode is not shown: a wrong timecode is worse than a missing cell.
   */
  seconds: number[]
}

/**
 * Picks the cells that one sheet shows, evenly across the window.
 *
 * The timecode of a cell is the platform's own, not an interpolation: that is the difference
 * between quoting "at 02:21" and guessing it.
 */
export function pickSpriteCells(
  geometry: SpriteGeometry,
  window: { fromSeconds: number, toSeconds: number },
  cells: number,
): Array<{ x: number, y: number, index: number, atSeconds: number }> {
  const all = geometry.seconds.map((atSeconds, index) => ({ atSeconds, index }))
  if (all.length === 0)
    return []
  const inside = all.filter(cell => cell.atSeconds >= window.fromSeconds && cell.atSeconds <= window.toSeconds)
  const source = inside.length > 0 ? inside : all

  const picked: Array<{ x: number, y: number, index: number, atSeconds: number }> = []
  for (let slot = 0; slot < cells; slot++) {
    const position = cells === 1
      ? 0
      : Math.round((slot * (source.length - 1)) / (cells - 1))
    const cell = source[Math.min(position, source.length - 1)]!
    picked.push({
      x: (cell.index % geometry.columns) * geometry.cellWidth,
      y: Math.floor(cell.index / geometry.columns) * geometry.cellHeight,
      index: cell.index,
      atSeconds: cell.atSeconds,
    })
  }
  return picked
}

/**
 * The `filter_complex` that cuts the picked cells out of a sprite and stacks them into one image:
 * `split` feeds every crop, rows join with `hstack`, and the rows join with `vstack`.
 */
export function spriteFilterGraph(
  picked: Array<{ x: number, y: number }>,
  cell: { width: number, height: number },
  columns: number,
): string {
  const rowCount = Math.ceil(picked.length / columns)
  if (picked.length === 0 || rowCount === 0)
    throw new Error('no cells to draw.')

  const labels = picked.map((_, index) => `[s${index}]`).join('')
  const crops = picked
    .map((position, index) => `[s${index}]crop=${cell.width}:${cell.height}:${position.x}:${position.y}[c${index}]`)
    .join(';')

  const rows = Array.from({ length: rowCount }, (_, row) => {
    const cells = Array.from({ length: columns }, (_, column) => `[c${row * columns + column}]`).join('')
    return `${cells}hstack=${columns}[r${row}]`
  }).join(';')

  const stack = rowCount === 1
    ? `[r0]null[sheet]`
    : `${Array.from({ length: rowCount }, (_, row) => `[r${row}]`).join('')}vstack=${rowCount}[sheet]`

  return `[0:v]split=${picked.length}${labels};${crops};${rows};${stack}`
}

export function createVideoEngine(options: VideoEngineOptions) {
  // Resolved per call, not once at construction: the settings page can point at a binary after this
  // engine exists, and a machine that installs ffmpeg later works without a restart.
  let overrideFfmpeg = options.ffmpegPath
  const overrideFfprobe = options.ffprobePath
  const bundledDir = options.bundledDir

  /** A binary that travels with the app, checked per call so a rebuilt install needs no restart. */
  function bundled(binary: 'ffmpeg' | 'ffprobe'): string {
    if (!bundledDir)
      return ''
    for (const name of process.platform === 'win32' ? [`${binary}.exe`, binary] : [binary]) {
      const candidate = join(bundledDir, name)
      if (existsSync(candidate))
        return candidate
    }
    return ''
  }

  type BinarySource = 'setting' | 'env' | 'bundled' | 'path' | 'missing'

  /** Whichever rule won, so the settings page can say where the binary came from. */
  function ffmpegSource(): BinarySource {
    if (overrideFfmpeg)
      return 'setting'
    if (process.env.AIRI_FFMPEG_PATH)
      return 'env'
    if (bundled('ffmpeg'))
      return 'bundled'
    return findOnPath('ffmpeg') ? 'path' : 'missing'
  }

  const ffmpegPathOf = () => overrideFfmpeg || process.env.AIRI_FFMPEG_PATH || bundled('ffmpeg') || findOnPath('ffmpeg')
  const ffprobePathOf = () => overrideFfprobe || process.env.AIRI_FFPROBE_PATH || bundled('ffprobe') || findOnPath('ffprobe')
  const fetchImpl = options.fetchImpl ?? fetch
  const cacheDir = options.cacheDir

  /** Runs a binary and collects its output. Rejects with the last stderr line, which is the useful one. */
  function run(binary: string, args: string[], runOptions: { timeoutMs?: number } = {}): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
      if (!binary)
        return reject(new Error('ffmpeg was not found. Set AIRI_FFMPEG_PATH, or put ffmpeg on PATH.'))
      const child = spawn(binary, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = runOptions.timeoutMs
        ? setTimeout(() => {
            child.kill()
            reject(new Error(`${basename(binary)} timed out after ${Math.round(runOptions.timeoutMs! / 1000)} s.`))
          }, runOptions.timeoutMs)
        : undefined
      child.stdout.on('data', chunk => (stdout += chunk))
      child.stderr.on('data', chunk => (stderr += chunk))
      child.on('error', (error) => {
        if (settled)
          return
        settled = true
        if (timer)
          clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        if (settled)
          return
        settled = true
        if (timer)
          clearTimeout(timer)
        if (code === 0)
          return resolve({ stdout, stderr })
        const lastLine = stderr.trim().split('\n').filter(Boolean).at(-1) ?? ''
        reject(new Error(`${basename(binary)} exited with ${code}: ${lastLine}`))
      })
    })
  }

  function cacheDirFor(source: string): string {
    return join(cacheDir, createHash('sha1').update(source).digest('hex').slice(0, 16))
  }

  /** Reads the `bvid` out of a link, a bare id, a short link target, or an `av` id. */
  function bilibiliRefOf(source: string): { bvid?: string, avid?: number } | undefined {
    const bv = source.match(/BV[0-9A-Za-z]{10}/)
    if (bv)
      return { bvid: bv[0] }
    if (source.startsWith('av') && /^\d+$/.test(source.slice(2)))
      return { avid: Number(source.slice(2)) }
    const av = source.match(/(?:^|\/|av)(\d{5,})$/i)
    if (av && /bilibili|b23|\/av/i.test(source))
      return { avid: Number(av[1]) }
    return undefined
  }

  /** Every bilibili call carries the same headers; a cookie unlocks captions and 720p+. */
  function bilibiliHeaders(cookie?: string): Record<string, string> {
    return {
      'User-Agent': USER_AGENT,
      'Referer': BILIBILI_REFERER,
      ...(cookie ? { Cookie: cookie } : {}),
    }
  }

  async function bilibiliJson<T>(url: string, cookie?: string): Promise<T> {
    const response = await fetchImpl(url, { headers: bilibiliHeaders(cookie) })
    if (!response.ok)
      throw new Error(`bilibili answered ${response.status} for ${new URL(url).pathname}.`)
    const body = await response.json() as { code: number, message?: string, data?: T }
    if (body.code !== 0)
      throw new Error(`bilibili answered code ${body.code}: ${body.message ?? 'unknown error'}.`)
    if (!body.data)
      throw new Error('bilibili returned no data.')
    return body.data
  }

  /**
   * The order bilibili mixes the two halves of its wbi keys in.
   *
   * Measured 2026-11-03: the unsigned `x/player/v2` endpoint answers a caption request with
   * another video's captions (8 requests for one clip returned 0, 6, and 1 track whose cues ran
   * to 836 s of a 349 s clip). The signed `x/player/wbi/v2` answered the same clip 8 times out of
   * 8 with the same 143 cues ending at exactly 349 s. So the signature is not an optional header:
   * without it the text track is not this video's text.
   */
  const WBI_MIXIN_ORDER = (
    '46 47 18 2 53 8 23 32 15 50 10 31 58 3 45 35 '
    + '27 43 5 49 33 9 42 19 29 28 14 39 12 38 41 13 '
    + '37 48 7 16 24 55 40 61 26 17 0 1 60 51 30 4 '
    + '22 25 54 21 56 59 6 63 57 62 11 36 20 34 44 52'
  ).split(' ').map(Number)
  /** The keys rotate, and every signed request in one run can share them. */
  const WBI_KEY_TTL_MS = 6 * 3_600_000
  let wbiMixin: { key: string, at: number } | undefined

  /** The mixing key of the two nav images, fetched at most once per six hours. */
  async function wbiMixinKey(cookie?: string): Promise<string> {
    const now = Date.now()
    if (wbiMixin && now - wbiMixin.at < WBI_KEY_TTL_MS)
      return wbiMixin.key

    const nav = await bilibiliJson<{ wbi_img?: { img_url?: string, sub_url?: string } }>(
      'https://api.bilibili.com/x/web-interface/nav',
      cookie,
    )
    const nameOf = (url?: string) => url?.split('/').pop()?.split('.')[0] ?? ''
    const raw = `${nameOf(nav.wbi_img?.img_url)}${nameOf(nav.wbi_img?.sub_url)}`
    if (raw.length < 64)
      throw new Error('bilibili published no wbi keys, so a signed player request cannot be made.')

    const key = WBI_MIXIN_ORDER.map(index => raw[index] ?? '').join('').slice(0, 32)
    wbiMixin = { key, at: now }
    return key
  }

  /** `params` plus `wts` and `w_rid`, as the signed player endpoint expects them. */
  async function signedQuery(params: Record<string, string | number>, cookie?: string): Promise<string> {
    const mixin = await wbiMixinKey(cookie)
    const withTime: Record<string, string | number> = { ...params, wts: Math.floor(Date.now() / 1000) }
    const query = Object.keys(withTime)
      .sort()
      .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(String(withTime[name]))}`)
      .join('&')
    const wRid = createHash('md5').update(`${query}${mixin}`).digest('hex')
    return `${query}&w_rid=${wRid}`
  }

  interface BilibiliMeta {
    bvid: string
    cid: number
    title: string
    durationSeconds: number
    width: number
    height: number
  }

  async function bilibiliMeta(reference: { bvid?: string, avid?: number }, cookie?: string): Promise<BilibiliMeta> {
    const query = reference.bvid ? `bvid=${reference.bvid}` : `aid=${reference.avid}`
    const view = await bilibiliJson<{
      bvid: string
      cid: number
      title: string
      duration: number
      dimension?: { width: number, height: number }
    }>(`https://api.bilibili.com/x/web-interface/view?${query}`, cookie)
    return {
      bvid: view.bvid,
      cid: view.cid,
      title: view.title,
      durationSeconds: view.duration,
      width: view.dimension?.width ?? 0,
      height: view.dimension?.height ?? 0,
    }
  }

  /** The platform sprite, downloaded once and kept: ~265 KB for a whole clip. */
  async function bilibiliSprite(meta: BilibiliMeta, cookie?: string): Promise<SpriteGeometry & { path: string }> {
    const dir = cacheDirFor(`bilibili:${meta.bvid}`)
    const target = join(dir, 'sprite.jpg')
    await mkdir(dir, { recursive: true })

    const shot = await bilibiliJson<{
      img_x_len: number
      img_y_len: number
      img_x_size: number
      img_y_size: number
      image: string[]
      index: number[]
    }>(`https://api.bilibili.com/x/player/videoshot?bvid=${meta.bvid}&cid=${meta.cid}&index=1`, cookie)

    const first = shot.image?.[0]
    if (!first)
      throw new Error('this video publishes no contact sheet.')

    if (!existsSync(target)) {
      const url = first.startsWith('//') ? `https:${first}` : first
      // The sprite host is a CDN that throttles bursts, so one retry is worth more than a
      // fallback that decodes the clip.
      let lastStatus = 0
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl(url, { headers: bilibiliHeaders(cookie) })
        if (response.ok) {
          await writeFile(target, new Uint8Array(await response.arrayBuffer()))
          break
        }
        lastStatus = response.status
      }
      if (!existsSync(target))
        throw new Error(`the contact sheet answered ${lastStatus}.`)
    }

    return {
      path: target,
      columns: shot.img_x_len,
      rows: shot.img_y_len,
      cellWidth: shot.img_x_size,
      cellHeight: shot.img_y_size,
      // `index` holds the seconds of each cell, in reading order.
      seconds: shot.index ?? [],
    }
  }

  /** The best stream URL the reply offers, with the headers it needs. */
  async function bilibiliStream(meta: BilibiliMeta, cookie?: string): Promise<{ url: string, headers: Record<string, string> }> {
    const play = await bilibiliJson<{
      durl?: Array<{ url: string }>
      dash?: { video: Array<{ baseUrl?: string, base_url?: string, bandwidth: number }> }
    }>(
      `https://api.bilibili.com/x/player/playurl?bvid=${meta.bvid}&cid=${meta.cid}&qn=80&fnval=16&fourk=1`,
      cookie,
    )
    const best = [...(play.dash?.video ?? [])].sort((a, b) => b.bandwidth - a.bandwidth)[0]
    const url = best?.baseUrl ?? best?.base_url ?? play.durl?.[0]?.url
    if (!url)
      throw new Error('bilibili returned no playable stream for this video.')
    return { url, headers: bilibiliHeaders(cookie) }
  }

  /** ffmpeg reads a remote stream by byte range, so a seek transfers the window, not the film. */
  function openInput(input: string, headers?: Record<string, string>): string[] {
    if (!headers)
      return ['-i', input]
    const headerArgument = `${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n`
    return ['-headers', headerArgument, '-i', input]
  }

  async function probe(source: string, request: { cookie?: string } = {}): Promise<VideoProbeResult> {
    try {
      const reference = bilibiliRefOf(source.trim())
      if (reference) {
        const meta = await bilibiliMeta(reference, request.cookie)
        let hasClosedCaptions = false
        try {
          hasClosedCaptions = (await bilibiliCaptionList(meta, request.cookie)).length > 0
        }
        catch {
          // A caption lookup that fails is not a failed probe: the picture path works without it.
        }
        return {
          durationSeconds: meta.durationSeconds,
          width: meta.width,
          height: meta.height,
          fps: 0,
          hasAudio: true,
          hasTextTrack: hasClosedCaptions,
          hasClosedCaptions,
          source: `bilibili:${meta.bvid}`,
          cached: true,
          title: meta.title,
        } satisfies VideoProbe
      }

      const info = JSON.parse((await run(ffprobePathOf(), [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        source,
      ], { timeoutMs: 60_000 })).stdout) as {
        format?: { duration?: string }
        streams?: Array<{ codec_type: string, width?: number, height?: number, avg_frame_rate?: string }>
      }
      const streams = info.streams ?? []
      const videoStream = streams.find(stream => stream.codec_type === 'video')
      if (!videoStream)
        throw new Error('this source has no video stream.')
      const [num, den] = (videoStream.avg_frame_rate ?? '0/1').split('/').map(Number)
      const hasEmbeddedSubtitles = streams.some(stream => stream.codec_type === 'subtitle')
      return {
        durationSeconds: Number(info.format?.duration ?? 0),
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        fps: den ? Number((num / den).toFixed(3)) : 0,
        hasAudio: streams.some(stream => stream.codec_type === 'audio'),
        hasTextTrack: hasEmbeddedSubtitles,
        hasClosedCaptions: hasEmbeddedSubtitles,
        source,
        cached: false,
      } satisfies VideoProbe
    }
    catch (error) {
      return { error: errorMessageFrom(error) ?? String(error) }
    }
  }

  /** Reads the text track: the platform's captions for a link, an embedded stream for a file. */
  async function text(source: string, request: { cookie?: string, maxChars?: number } = {}): Promise<VideoTextResult> {
    const maxChars = request.maxChars ?? 12_000
    try {
      const reference = bilibiliRefOf(source.trim())
      const lines = reference
        ? await bilibiliCaptionLines(await bilibiliMeta(reference, request.cookie), request.cookie)
        : await embeddedSubtitleLines(source)

      if (lines.length === 0) {
        const noCaptions = request.cookie?.trim()
          ? 'the platform returned no captions for this video even with the cookie. Read the picture with builtIn_videoStoryboard instead.'
          : 'this video publishes no captions to an anonymous request. Fill the bilibili cookie in the video module, or read the picture with builtIn_videoStoryboard.'
        return {
          error: reference ? noCaptions : 'this source has no subtitle stream. Read the picture with builtIn_videoStoryboard.',
        }
      }

      const kept: string[] = []
      let chars = 0
      for (const line of lines) {
        if (chars + line.length > maxChars && kept.length > 0)
          break
        kept.push(line)
        chars += line.length + 1
      }

      return {
        text: kept.join('\n'),
        lines: kept.length,
        chars,
        truncated: kept.length < lines.length,
        origin: reference ? 'platform' : 'embedded',
      } satisfies VideoTextTrack
    }
    catch (error) {
      return { error: errorMessageFrom(error) ?? String(error) }
    }
  }

  async function bilibiliCaptionList(meta: BilibiliMeta, cookie?: string) {
    // Signed on purpose: the unsigned endpoint above answers with another clip's captions.
    const query = await signedQuery({ bvid: meta.bvid, cid: meta.cid }, cookie)
    const player = await bilibiliJson<{ subtitle?: { subtitles?: Array<{ subtitle_url?: string }> } }>(
      `https://api.bilibili.com/x/player/wbi/v2?${query}`,
      cookie,
    )
    return player.subtitle?.subtitles ?? []
  }

  async function bilibiliCaptionLines(meta: BilibiliMeta, cookie?: string) {
    const track = (await bilibiliCaptionList(meta, cookie)).find(entry => entry.subtitle_url)?.subtitle_url
    if (!track)
      return []
    const url = track.startsWith('//') ? `https:${track}` : track
    const body = await (await fetchImpl(url, { headers: bilibiliHeaders(cookie) })).json() as { body?: Array<{ from: number, content: string, to?: number }> }
    const cues = body.body ?? []

    // Measured 2026-11-03: a caption list that runs past the end of the clip is another video's.
    // Quoting it would put someone else's words in her mouth, so refuse instead of shortening it.
    const lastEnd = cues.reduce((max, cue) => Math.max(max, cue.to ?? cue.from), 0)
    if (lastEnd > meta.durationSeconds * 1.1 + 30) {
      throw new Error(
        `the platform answered with captions that run to ${Math.round(lastEnd)} s of a ${Math.round(meta.durationSeconds)} s video, so they belong to another clip. Read the picture with builtIn_videoStoryboard instead.`,
      )
    }
    return bilibiliCuesToLines(cues)
  }

  async function embeddedSubtitleLines(source: string) {
    const streams = JSON.parse((await run(ffprobePathOf(), [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-select_streams',
      's',
      source,
    ], { timeoutMs: 30_000 })).stdout) as { streams?: unknown[] }
    if ((streams.streams ?? []).length === 0)
      return []
    const srt = (await run(ffmpegPathOf(), [
      '-v',
      'error',
      '-i',
      source,
      '-map',
      '0:s:0',
      '-f',
      'srt',
      'pipe:1',
    ], { timeoutMs: 60_000 })).stdout
    return srtToLines(srt)
  }

  async function durationOf(source: string): Promise<number> {
    const info = JSON.parse((await run(ffprobePathOf(), [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      source,
    ], { timeoutMs: 60_000 })).stdout) as { format?: { duration?: string } }
    const duration = Number(info.format?.duration ?? 0)
    if (!duration)
      throw new Error('this source reports no duration.')
    return duration
  }

  /**
   * The size of a rendered sheet, read back from the file.
   *
   * The grid is computed from the source aspect, so a square assumption would report a height no
   * one asked for; the reply quotes cell timecodes against this image, so it has to be exact.
   */
  async function imageSizeOf(path: string): Promise<{ width: number, height: number }> {
    const info = JSON.parse((await run(ffprobePathOf(), [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-print_format',
      'json',
      path,
    ], { timeoutMs: 30_000 })).stdout) as { streams?: Array<{ width?: number, height?: number }> }
    return { width: info.streams?.[0]?.width ?? 0, height: info.streams?.[0]?.height ?? 0 }
  }

  /**
   * One sheet of a window of the video.
   *
   * A whole clip of a bilibili video comes from its sprite, with no decode. A window, or any other
   * source, is a ranged decode: ffmpeg seeks and reads only what it samples.
   */
  async function sheet(source: string, request: { fromSeconds?: number, toSeconds?: number, cells: number, cookie?: string }): Promise<VideoSheetResult> {
    try {
      const cells = Math.max(1, Math.min(36, Math.round(request.cells)))
      const reference = bilibiliRefOf(source.trim())

      if (reference) {
        const meta = await bilibiliMeta(reference, request.cookie)
        const from = clamp(request.fromSeconds ?? 0, 0, Math.max(0, meta.durationSeconds - 1))
        const to = clamp(request.toSeconds ?? meta.durationSeconds, from + 1, meta.durationSeconds)
        const wholeClip = from <= 0.5 && to >= meta.durationSeconds - 1

        if (wholeClip) {
          try {
            const sprite = await bilibiliSprite(meta, request.cookie)
            if (sprite.seconds.length > 0)
              return await sheetFromSprite(source, sprite, { fromSeconds: from, toSeconds: to, cells })
          }
          catch (error) {
            // No sprite for this video: the ranged decode below answers anyway.
            if (process.env.AIRI_VIDEO_DEBUG)
              console.warn('[video] the sprite path failed:', errorMessageFrom(error))
          }
        }

        if (wholeClip && (to - from) > MAX_DECODE_WINDOW_SECONDS)
          throw new Error(`this video publishes no contact sheet, and decoding all ${Math.round(to - from)} s of it is too slow. Ask for a window under ${MAX_DECODE_WINDOW_SECONDS} s instead.`)

        const stream = await bilibiliStream(meta, request.cookie)
        return await sheetFromStream(source, stream.url, stream.headers, { fromSeconds: from, toSeconds: to, cells })
      }

      const duration = await durationOf(source)
      const from = clamp(request.fromSeconds ?? 0, 0, Math.max(0, duration - 1))
      const to = clamp(request.toSeconds ?? duration, from + 1, duration)
      return await sheetFromStream(source, source, undefined, { fromSeconds: from, toSeconds: to, cells })
    }
    catch (error) {
      return { error: errorMessageFrom(error) ?? String(error) }
    }
  }

  /** Cuts the picked cells out of the cached sprite. The only bytes read are the sprite's own. */
  async function sheetFromSprite(
    source: string,
    sprite: SpriteGeometry & { path: string },
    window: { fromSeconds: number, toSeconds: number, cells: number },
  ): Promise<VideoSheet> {
    const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(window.cells))))
    const rows = Math.ceil(window.cells / columns)
    const count = columns * rows
    const picked = pickSpriteCells(sprite, window, count)

    const cellWidth = Math.max(CELL_MIN_PX, Math.min(CELL_MAX_PX, Math.floor(SHEET_MAX_WIDTH / columns)))
    const cellHeight = Math.round(cellWidth * (sprite.cellHeight / sprite.cellWidth))

    const dir = cacheDirFor(source.trim())
    const key = createHash('sha1').update(`sprite:${picked.map(cell => cell.index).join(',')}:${cellWidth}`).digest('hex').slice(0, 12)
    const target = join(dir, `sheet-${key}.png`)
    await mkdir(dir, { recursive: true })

    let cached = existsSync(target)
    if (!cached) {
      const graph = `${spriteFilterGraph(picked, { width: cellWidth, height: cellHeight }, columns)};[sheet]format=rgb24[out]`
      await run(ffmpegPathOf(), [
        '-y',
        '-v',
        'error',
        '-i',
        sprite.path,
        '-filter_complex',
        graph,
        '-map',
        '[out]',
        '-frames:v',
        '1',
        target,
      ], { timeoutMs: 120_000 })
      cached = false
    }

    const size = await stat(target)
    const image = await imageSizeOf(target)
    return {
      imageDataUrl: `data:image/png;base64,${(await readFile(target)).toString('base64')}`,
      width: image.width || cellWidth * columns,
      height: image.height || cellHeight * rows,
      fromSeconds: window.fromSeconds,
      toSeconds: window.toSeconds,
      cells: picked.map((cell, index) => ({ index: index + 1, atSeconds: cell.atSeconds })),
      path: target,
      bytes: size.size,
      cached,
    }
  }

  /** Samples a window with one ranged decode. Used for zooms, and for sources without a sprite. */
  async function sheetFromStream(
    source: string,
    input: string,
    headers: Record<string, string> | undefined,
    window: { fromSeconds: number, toSeconds: number, cells: number },
  ): Promise<VideoSheet> {
    const span = window.toSeconds - window.fromSeconds
    if (span > MAX_DECODE_WINDOW_SECONDS)
      throw new Error(`that window is ${Math.round(span)} s. Ask for one under ${MAX_DECODE_WINDOW_SECONDS} s, or read the whole clip without a window.`)

    const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(window.cells))))
    const rows = Math.ceil(window.cells / columns)
    const count = columns * rows
    const cellPx = Math.max(CELL_MIN_PX, Math.min(CELL_MAX_PX, Math.floor(SHEET_MAX_WIDTH / columns)))

    const dir = cacheDirFor(source.trim())
    const key = createHash('sha1').update(`stream:${window.fromSeconds}:${window.toSeconds}:${count}:${cellPx}`).digest('hex').slice(0, 12)
    const target = join(dir, `window-${key}.png`)
    await mkdir(dir, { recursive: true })

    let cached = existsSync(target)
    if (!cached) {
      await run(ffmpegPathOf(), [
        '-y',
        '-v',
        'error',
        '-ss',
        String(window.fromSeconds),
        '-t',
        String(span),
        ...openInput(input, headers),
        '-vf',
        `fps=${(count / span).toFixed(6)},scale=${cellPx}:-2,tile=${columns}x${rows}`,
        '-frames:v',
        '1',
        target,
      ], { timeoutMs: 300_000 })
      cached = false
    }

    const size = await stat(target)
    const image = await imageSizeOf(target)
    return {
      imageDataUrl: `data:image/png;base64,${(await readFile(target)).toString('base64')}`,
      width: image.width || cellPx * columns,
      height: image.height || cellPx * rows,
      fromSeconds: window.fromSeconds,
      toSeconds: window.toSeconds,
      cells: Array.from({ length: count }, (_, index) => ({
        index: index + 1,
        atSeconds: Number((window.fromSeconds + (span * (index + 0.5)) / count).toFixed(2)),
      })),
      path: target,
      bytes: size.size,
      cached,
    }
  }

  return {
    probe,
    text,
    sheet,
    /** Points the engine at a binary the owner picked, without rebuilding it. Empty clears it. */
    setFfmpegPath: (path?: string) => {
      overrideFfmpeg = path?.trim() || undefined
    },
    /** For the settings page: whether this build can decode anything at all. */
    capabilities: () => {
      const ffmpegPath = ffmpegPathOf()
      return { ffmpegPath, ffmpegSource: ffmpegSource(), ffprobePath: ffprobePathOf(), cacheDir, available: Boolean(ffmpegPath) }
    },
  }
}

export type VideoEngine = ReturnType<typeof createVideoEngine>

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function findOnPath(binary: string): string {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory)
      continue
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`)
      if (existsSync(candidate))
        return candidate
    }
  }
  return ''
}

export type { VideoProbe, VideoSheet, VideoTextTrack }
