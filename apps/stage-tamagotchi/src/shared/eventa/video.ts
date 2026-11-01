import type { VideoProbe, VideoSheet, VideoTextTrack } from '@proj-airi/stage-ui/tools/video'

import { defineInvokeEventa } from '@moeru/eventa'

/**
 * Watching a video from the renderer.
 *
 * The decode runs in the main process: it owns ffmpeg, the cache directory and the network
 * (a bilibili link is downloaded once). The renderer only asks, and gets either a result or a
 * message that the chat can show as the reason the video was not watched.
 */

export type ElectronVideoResult<T> = T | { error: string }

export interface ElectronVideoProbeInput {
  /** Bilibili id or link, a direct media URL, or an absolute local path. */
  source: string
  /** `SESSDATA=…; bili_jct=…`, so a private or captioned video resolves. */
  cookie?: string
  /** An `ffmpeg` the owner pointed at in the settings, which wins over PATH. */
  ffmpegPath?: string
}

export interface ElectronVideoTextInput extends ElectronVideoProbeInput {
  /** Characters to keep. The transcript is capped so it cannot flood the context. */
  maxChars?: number
}

export interface ElectronVideoSheetInput extends ElectronVideoProbeInput {
  fromSeconds?: number
  toSeconds?: number
  cells: number
}

/** What this build can decode. Read by the settings page to explain a missing ffmpeg. */
export interface ElectronVideoCapabilities {
  available: boolean
  ffmpegPath: string
  cacheDir: string
}

export const electronVideoProbe = defineInvokeEventa<ElectronVideoResult<VideoProbe>, ElectronVideoProbeInput>('eventa:invoke:electron:video:probe')
export const electronVideoText = defineInvokeEventa<ElectronVideoResult<VideoTextTrack>, ElectronVideoTextInput>('eventa:invoke:electron:video:text')
export const electronVideoSheet = defineInvokeEventa<ElectronVideoResult<VideoSheet>, ElectronVideoSheetInput>('eventa:invoke:electron:video:sheet')
export const electronVideoCapabilities = defineInvokeEventa<ElectronVideoCapabilities>('eventa:invoke:electron:video:capabilities')
