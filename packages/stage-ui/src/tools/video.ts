import type { Tool, ToolExecuteResult } from '@xsai/shared-chat'

import { rawTool } from '@xsai/tool'
import { description, maxLength, maxValue, minLength, minValue, nullable, number, pipe, safeParse, strictObject, string } from 'valibot'
import { toJsonSchema } from 'xsschema'

/**
 * Video tools: let the character actually watch a clip instead of reading a caption.
 *
 * The shapes are the ones measured to be affordable:
 * - a contact sheet is billed by area, not by cell, so one 1440 px sheet (~1.0k vision
 *   tokens) covers a whole clip at 9-25 moments;
 * - the text track is a few thousand tokens and is the only part that can be quoted;
 * - per-frame reading is the trap: 883 frames of a 33 s clip is ~610k tokens.
 *
 * The runtime lives in the desktop shell (`main/services/airi/video`), so this file only
 * describes the tools and their parameters. The web build registers none of them.
 */

export const VIDEO_PROBE_TOOL_NAME = 'builtIn_videoProbe'
export const VIDEO_OUTLINE_TOOL_NAME = 'builtIn_videoOutline'
export const VIDEO_STORYBOARD_TOOL_NAME = 'builtIn_videoStoryboard'
export const VIDEO_ZOOM_TOOL_NAME = 'builtIn_videoZoom'
/** Queues a clip for later, or reads back what she already watched on her own. */
export const VIDEO_REMEMBER_TOOL_NAME = 'builtIn_videoRemember'

export const VIDEO_TOOL_NAMES = [
  VIDEO_PROBE_TOOL_NAME,
  VIDEO_OUTLINE_TOOL_NAME,
  VIDEO_STORYBOARD_TOOL_NAME,
  VIDEO_ZOOM_TOOL_NAME,
  VIDEO_REMEMBER_TOOL_NAME,
] as const

/** How much of a video a call reads. `skim` is one sheet, `deep` adds zoom and more cells. */
export type VideoDepth = 'skim' | 'read' | 'deep'

/** The part of the system prompt that says when to watch, and how to cite what was watched. */
export const VIDEO_TOOLSET_PROMPT = `You can watch a video with the built-in video tools.
When the user asks about a specific video, or hands you a link, file or bilibili id:
- call \`${VIDEO_PROBE_TOOL_NAME}\` first: it returns the duration, the resolution, and whether a text track exists;
- call \`${VIDEO_OUTLINE_TOOL_NAME}\` when \`hasTextTrack\` is true: it returns the speech as \`[mm:ss]\` rows, which is the cheapest and the only quotable part of a video;
- call \`${VIDEO_STORYBOARD_TOOL_NAME}\` for one contact sheet of the whole clip, and read the cell index against the timecodes it returns;
- call \`${VIDEO_ZOOM_TOOL_NAME}\` only when the answer needs a moment you cannot see at sheet resolution. Each zoom is an extra image.
Rules:
- Quote a timestamp for every claim about what happens or what is said. If you cannot name a timestamp, you did not watch it.
- Never describe what happens outside the window you were given, and say plainly when a clip has no text track.
- Do not re-watch a video you already read in this conversation: the sheet and the outline stay in the history.
- When something is worth watching later rather than now, or the owner says "回头再看", queue it with ${VIDEO_REMEMBER_TOOL_NAME} instead of watching it in this turn: you may pick it up on your own when the moment is yours. Call that tool with action recall to remember what you watched by yourself, and quote those timecodes.
- What you watch on your own goes up on the sharing panel. When it is worth talking about, open that panel with stage_widgets componentName video-share, and say one line about why you put it there.`

/** Metadata of a resolved video. */
export interface VideoProbe {
  /** Platform title, when the source was a link. */
  title?: string
  durationSeconds: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  /** `true` when an embedded subtitle stream or a platform caption list exists. */
  hasTextTrack: boolean
  /**
   * `true` when the platform publishes captions for this video at all.
   *
   * A link read without a login can report `false` here and still have captions behind a cookie,
   * so the transcript error says which of the two it is.
   */
  hasClosedCaptions?: boolean
  /** `bilibili:BV…` for a link, else the local path or URL that was read. */
  source: string
  /** `true` when the answer came from a cache: a sprite, or a rendered sheet. */
  cached: boolean
}

/** The speech of a video, one `[mm:ss]` row per cue. */
export interface VideoTextTrack {
  text: string
  lines: number
  chars: number
  truncated: boolean
  /** `embedded` subtitle stream, `platform` captions, or a local `asr` run. */
  origin: 'embedded' | 'platform' | 'asr'
}

/** One cell of a contact sheet. */
export interface VideoSheetCell {
  /** 1-based position in the sheet, left to right, top to bottom. */
  index: number
  atSeconds: number
}

/** One contact sheet of a window of a video. */
export interface VideoSheet {
  /** A `data:` URL, so the image part of the tool result needs no file access. */
  imageDataUrl: string
  width: number
  height: number
  fromSeconds: number
  toSeconds: number
  cells: VideoSheetCell[]
  /** Where the PNG is on disk, for the chat card and for debugging. */
  path: string
  bytes: number
  cached: boolean
}

export interface VideoFailure { error: string }

/** What the desktop shell implements. The renderer owns the options, so one runtime serves every chat. */
export interface VideoToolRuntime {
  probe: (source: string) => Promise<VideoProbe | VideoFailure>
  text: (source: string) => Promise<VideoTextTrack | VideoFailure>
  sheet: (request: { source: string, fromSeconds?: number, toSeconds?: number, cells: number }) => Promise<VideoSheet | VideoFailure>
  /**
   * The queue she decides from, when the shell has one.
   *
   * Absent, the remember tool is not mounted at all: an offer to queue a clip that nothing will
   * ever pick up is worse than no offer.
   */
  watchlist?: {
    enqueue: (input: { source: string, why: string }) => Promise<{ queued: number, message: string }>
    recall: (limit: number) => Promise<string>
  }
}

/** Caps one conversation: a model that keeps zooming spends image tokens the user never asked for. */
export interface VideoBudget {
  sheets: number
  zooms: number
}

export const defaultVideoBudget: VideoBudget = { sheets: 4, zooms: 6 }

/** Cells per depth level. More cells is free in tokens, but each cell gets smaller. */
export function cellsForDepth(depth: VideoDepth): number {
  return depth === 'skim' ? 9 : depth === 'read' ? 16 : 25
}

const sourceField = pipe(
  string(),
  minLength(1),
  maxLength(2048),
  description('A bilibili video (BV id, bilibili.com link, b23.tv link), a direct http(s) video URL, or an absolute local file path.'),
)

const probeParameters = strictObject({ source: sourceField })

const outlineParameters = strictObject({
  source: sourceField,
  max_chars: nullable(pipe(
    number(),
    minValue(500),
    maxValue(40_000),
    description('How much of the transcript to keep, in characters. Null keeps the default of 12000, about 8k tokens.'),
  )),
})

const storyboardParameters = strictObject({
  source: sourceField,
  from_seconds: nullable(pipe(number(), minValue(0), description('Start of the window to cover. Null starts at the beginning.'))),
  to_seconds: nullable(pipe(number(), minValue(0), description('End of the window to cover. Null runs to the end of the clip.'))),
  cells: nullable(pipe(
    number(),
    minValue(4),
    maxValue(25),
    description('How many moments the sheet holds. Null uses the module setting: 9 to skim, 16 to read, 25 to look closely.'),
  )),
})

const zoomParameters = strictObject({
  source: sourceField,
  from_seconds: pipe(number(), minValue(0), description('Start of the moment to look at, in seconds.')),
  to_seconds: pipe(number(), minValue(0), description('End of the moment to look at, in seconds. Keep the window under 120 s.')),
  cells: nullable(pipe(
    number(),
    minValue(1),
    maxValue(9),
    description('How many frames of that window the sheet holds. Null uses 6. Fewer is bigger per frame.'),
  )),
})

const rememberParameters = strictObject({
  action: pipe(
    string(),
    description('`queue` puts a clip on your own watchlist. `recall` reads back what you already watched by yourself, with the note you wrote.'),
  ),
  source: nullable(pipe(string(), description('For `queue`: the bilibili id or link, direct URL, or absolute path. Null for `recall`.'))),
  why: nullable(pipe(string(), description('For `queue`: one first-person line on why it is worth watching, so future you knows. Null when you have no reason yet.'))),
  limit: nullable(pipe(number(), minValue(1), maxValue(10), description('For `recall`: how many recent watches to read. Null keeps 5.'))),
})

/** `value` when it is a decided number, else `fallback`. Tool arguments arrive as `null` for "unset". */
function orDefault(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * Creates the video tools over a runtime.
 *
 * `budget` is per tool set, that is per app session: the desktop shell rebuilds the tools when
 * the module or its settings change, which also resets the budget.
 */
export async function createVideoTools(
  runtime: VideoToolRuntime,
  options: { budget?: VideoBudget, depth?: () => VideoDepth } = {},
): Promise<Tool[]> {
  const budget: VideoBudget = { ...defaultVideoBudget, ...options.budget }
  const depthOf = options.depth ?? (() => 'read' as VideoDepth)

  const tools: Tool[] = [
    rawTool({
      name: VIDEO_PROBE_TOOL_NAME,
      description: [
        'Read a video\'s metadata before watching it: duration, resolution, frame rate, whether it has audio, and whether it has a text track.',
        'Costs no image. Call it first for any video you are asked about.',
      ].join(' '),
      parameters: await toJsonSchema(probeParameters),
      execute: async (rawInput): Promise<ToolExecuteResult> => {
        const parsed = safeParse(probeParameters, rawInput)
        if (!parsed.success)
          return 'The video was not probed: `source` is required.'
        const result = await runtime.probe(parsed.output.source)
        if ('error' in result)
          return `Could not read that video: ${result.error}`
        return json(result)
      },
    }),

    rawTool({
      name: VIDEO_OUTLINE_TOOL_NAME,
      description: [
        'Read the speech of a video as `[mm:ss] text` rows. This is the cheapest way to watch, and the only one whose lines can be quoted.',
        'Returns an error when the video has no text track, in which case read the picture with builtIn_videoStoryboard instead.',
      ].join(' '),
      parameters: await toJsonSchema(outlineParameters),
      execute: async (rawInput): Promise<ToolExecuteResult> => {
        const parsed = safeParse(outlineParameters, rawInput)
        if (!parsed.success)
          return 'The transcript was not read: `source` is required.'
        const result = await runtime.text(parsed.output.source)
        if ('error' in result)
          return `No transcript: ${result.error}`
        const header = `Transcript of ${parsed.output.source} (${result.origin}, ${result.lines} rows, ${result.chars} chars${result.truncated ? ', truncated — ask for a later window with from_seconds' : ''}):`
        return `${header}\n\n${result.text}`
      },
    }),

    rawTool({
      name: VIDEO_STORYBOARD_TOOL_NAME,
      description: [
        'Render one contact sheet of a video: N moments spread evenly over the window, tiled into a single image, each cell with a timecode.',
        'Costs about 1k vision tokens for the whole sheet. Read the picture for what happens, then use builtIn_videoZoom for a moment that needs more detail.',
      ].join(' '),
      parameters: await toJsonSchema(storyboardParameters),
      execute: async (rawInput): Promise<ToolExecuteResult> => {
        const parsed = safeParse(storyboardParameters, rawInput)
        if (!parsed.success)
          return 'The sheet was not drawn: `source` is required.'
        if (budget.sheets <= 0)
          return 'No sheets left in this conversation. Answer from what you already saw, or ask the user to raise the video module\'s sheet budget.'
        budget.sheets -= 1
        const result = await runtime.sheet({
          source: parsed.output.source,
          fromSeconds: parsed.output.from_seconds ?? undefined,
          toSeconds: parsed.output.to_seconds ?? undefined,
          cells: orDefault(parsed.output.cells, cellsForDepth(depthOf())),
        })
        if ('error' in result)
          return `Could not draw the sheet: ${result.error}`
        return sheetResult(result, 'Contact sheet')
      },
    }),

    rawTool({
      name: VIDEO_ZOOM_TOOL_NAME,
      description: [
        'Look at one short window of a video in detail: 1-9 large frames of a few seconds to a couple of minutes.',
        'Use it only after a contact sheet showed the moment you need, and keep the window under about 120 s so each frame stays readable.',
      ].join(' '),
      parameters: await toJsonSchema(zoomParameters),
      execute: async (rawInput): Promise<ToolExecuteResult> => {
        const parsed = safeParse(zoomParameters, rawInput)
        if (!parsed.success)
          return 'The zoom was not drawn: `source`, `from_seconds` and `to_seconds` are required.'
        if (parsed.output.to_seconds <= parsed.output.from_seconds)
          return 'The zoom window is empty: `to_seconds` must be after `from_seconds`.'
        if (budget.zooms <= 0)
          return 'No zooms left in this conversation. Answer from the sheet you already have.'
        budget.zooms -= 1
        const result = await runtime.sheet({
          source: parsed.output.source,
          fromSeconds: parsed.output.from_seconds,
          toSeconds: parsed.output.to_seconds,
          cells: orDefault(parsed.output.cells, 6),
        })
        if ('error' in result)
          return `Could not zoom: ${result.error}`
        return sheetResult(result, 'Zoom')
      },
    }),
  ]

  // The watchlist tool exists only where a queue does: otherwise it would promise a pickup that
  // never comes.
  if (runtime.watchlist) {
    const watchlist = runtime.watchlist
    tools.push(rawTool({
      name: VIDEO_REMEMBER_TOOL_NAME,
      description: [
        'Keep a video for later on your own watchlist, or read back what you watched on your own.',
        'Queue when the owner says "later" or when a clip is interesting but the conversation is not about it.',
        'The autonomy policy may then watch a queued clip when the moment is yours, and you write the note yourself.',
      ].join(' '),
      parameters: await toJsonSchema(rememberParameters),
      execute: async (rawInput): Promise<ToolExecuteResult> => {
        const parsed = safeParse(rememberParameters, rawInput)
        if (!parsed.success)
          return 'Use action `queue` with a source, or action `recall`.'
        const { action, source, why, limit } = parsed.output

        if (action === 'recall')
          return await watchlist.recall(orDefault(limit, 5))

        if (!source)
          return 'Nothing was queued: `queue` needs a source.'

        const result = await watchlist.enqueue({ source, why: why ?? '' })
        return result.message
      },
    }))
  }

  return tools
}

/**
 * The result of a sheet call: the image first, then the index that binds each cell to a timecode.
 *
 * The image part is an `image_url` so a chat model that sees pictures reads the sheet directly,
 * and one that does not gets it described by the vision module (see `tool-images.ts`).
 */
function sheetResult(sheet: VideoSheet, label: string): ToolExecuteResult {
  const index = sheet.cells.map(cell => `#${cell.index} ${timestampOfSeconds(cell.atSeconds)}`).join('  ')
  const text = [
    `${label}: ${sheet.cells.length} cells, ${sheet.width}x${sheet.height}px, window ${timestampOfSeconds(sheet.fromSeconds)}–${timestampOfSeconds(sheet.toSeconds)}${sheet.cached ? ', from cache' : ''}.`,
    `Cell timecodes: ${index}`,
    'Cells run left to right, top to bottom. Quote these timecodes.',
  ].join('\n')

  if (!sheet.imageDataUrl)
    return text

  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: sheet.imageDataUrl, detail: 'high' } },
  ]
}

/** `mm:ss` for a timecode that the reply can quote. Floors, as a player shows it. */
export function timestampOfSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
