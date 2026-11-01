import type { createContext } from '@moeru/eventa/adapters/electron/main'

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
  return createVideoEngine({ cacheDir: join(app.getPath('userData'), 'video-cache') })
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

  defineInvokeHandler(context, electronVideoProbe, input =>
    engine.probe(input.source, { cookie: input.cookie }))

  defineInvokeHandler(context, electronVideoText, input =>
    engine.text(input.source, { cookie: input.cookie, maxChars: input.maxChars }))

  defineInvokeHandler(context, electronVideoSheet, input =>
    engine.sheet(input.source, {
      fromSeconds: input.fromSeconds,
      toSeconds: input.toSeconds,
      cells: input.cells,
      cookie: input.cookie,
    }))

  defineInvokeHandler(context, electronVideoCapabilities, () => engine.capabilities())
}
