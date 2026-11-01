import type { createContext } from '@moeru/eventa/adapters/electron/main'

import process from 'node:process'

import { join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import {
  electronVideoCapabilities,
  electronVideoProbe,
  electronVideoSheet,
  electronVideoText,
} from '../../../../shared/eventa/video'
import { createVideoEngine } from './engine'

export type { VideoEngine } from './engine'
export { createVideoEngine } from './engine'

/**
 * The engine of this install: media and sheets go under `userData`, so an update or a cache clear
 * finds them in one place and they never mix with the app bundle.
 */
export function createAppVideoEngine() {
  return createVideoEngine({
    cacheDir: join(app.getPath('userData'), 'video-cache'),
    // Shipped with the app (see `extraResources`), so a machine without ffmpeg on PATH still works.
    bundledDir: join(process.resourcesPath, 'ffmpeg'),
  })
}

/**
 * Registers the video invokes for a chat renderer.
 *
 * Only the chat windows need them: the settings page toggles the module, it never decodes a clip.
 */
export function createVideoService(params: {
  context: ReturnType<typeof createContext>['context']
  engine: ReturnType<typeof createVideoEngine>
}) {
  const { context, engine } = params

  /** The settings page can move the binary; every call carries the current choice. */
  function useFfmpeg(ffmpegPath?: string) {
    if (ffmpegPath !== undefined)
      engine.setFfmpegPath(ffmpegPath)
  }

  defineInvokeHandler(context, electronVideoProbe, (input) => {
    useFfmpeg(input.ffmpegPath)
    return engine.probe(input.source, { cookie: input.cookie })
  })

  defineInvokeHandler(context, electronVideoText, (input) => {
    useFfmpeg(input.ffmpegPath)
    return engine.text(input.source, { cookie: input.cookie, maxChars: input.maxChars })
  })

  defineInvokeHandler(context, electronVideoSheet, (input) => {
    useFfmpeg(input.ffmpegPath)
    return engine.sheet(input.source, {
      fromSeconds: input.fromSeconds,
      toSeconds: input.toSeconds,
      cells: input.cells,
      cookie: input.cookie,
    })
  })

  defineInvokeHandler(context, electronVideoCapabilities, () => engine.capabilities())
}
