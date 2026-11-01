import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'

import { useVisionOrchestratorStore } from '@proj-airi/stage-ui/stores/modules/vision'

import { parseActivityAssessment } from '@proj-airi/core-agent'

import { computerUseReadImage, computerUseRun } from '../../shared/eventa/computer-use'

/** One line the mind may think about. Structurally the `SenseObservation` of `@proj-airi/core-agent`. */
export interface ScreenSenseObservation {
  kind: 'screen'
  /** 「他在干什么」，一句中文。 */
  text: string
  at: number
  /** 视觉模型对这一眼的裁决：现在能不能打扰。缺省表示它没给意见。 */
  interruptible?: boolean
  reason?: string
}

/**
 * A sense port that lets the mind look at this computer's screen.
 *
 * The mind never holds pixels: one capture becomes one line of text through the vision workload, so curiosity
 * reacts to "a chat window with a long session list" rather than to a bitmap. The capture goes through the same
 * AUV path as the computer_use tool, and the WebP→PNG conversion happens in the main process.
 *
 * Returns an empty list on any failure — permission, no vision model, no display. A blind sense is the documented
 * default, so a temporary failure must not surface as an error the mind has to handle.
 */
export function createScreenSense() {
  let busy = false
  /** 最近一次 look 走到哪一步、拿到什么。没有它，「她看不见」和「她坏了」长得一模一样。 */
  let last: Record<string, unknown> = { stage: 'idle' }

  async function ask(imageDataUrl: string, workloadId: 'screen:activity' | 'screen:interpret') {
    const { text } = await useVisionOrchestratorStore().processCapture({
      imageDataUrl,
      workloadId,
      sourceId: 'sense:screen',
      capturedAt: Date.now(),
      publishContext: false,
    })
    return String(text ?? '').trim()
  }

  return {
    diagnostics: () => last,
    async look(): Promise<ScreenSenseObservation[]> {
      if (busy)
        return []
      busy = true
      try {
        const { context } = createContext(window.electron.ipcRenderer)
        const run = defineInvoke(context, computerUseRun)
        const readImage = defineInvoke(context, computerUseReadImage)

        const capture = await run({ argv: ['invoke', 'display.capture', '--json'] })
        last = { stage: 'capture', exitCode: capture?.exitCode, at: Date.now() }
        if (capture?.exitCode !== 0)
          return []

        const parsed = typeof capture.output === 'string' ? JSON.parse(capture.output) : capture.output as any
        const artifactPath = parsed?.artifacts?.[0]?.file_path
        last = { ...last, stage: 'artifact', hasPath: Boolean(artifactPath) }
        if (!artifactPath)
          return []

        const imageDataUrl = await readImage({ path: artifactPath })

        // `screen:activity` 一次问清两件事：他在干什么（activity）+ 现在能不能打扰（interruptible）。
        // 之前用 `screen:interpret` 只得到一段画面描述，再靠关键词猜忙不忙——那条路没有下限。
        let workload: 'screen:activity' | 'screen:interpret' = 'screen:activity'
        let raw = ''
        try {
          raw = await ask(imageDataUrl, workload)
        }
        catch (error) {
          last = { ...last, stage: 'activity-threw', error: String((error as Error)?.message ?? error).slice(0, 160) }
        }

        // 新工作负载没答上来（模型不认、返回空、请求被拒）就退回旧的描述型工作负载，
        // 至少留一行能看的画面：感知断掉比描述粗糙更糟。
        if (!raw) {
          workload = 'screen:interpret'
          try {
            raw = await ask(imageDataUrl, workload)
          }
          catch (error) {
            last = { ...last, stage: 'interpret-threw', error: String((error as Error)?.message ?? error).slice(0, 160) }
            return []
          }
        }

        last = { ...last, stage: 'answered', workload, chars: raw.length, raw: raw.slice(0, 160) }

        const assessment = workload === 'screen:activity' ? parseActivityAssessment(raw) : undefined
        if (assessment) {
          return [{
            kind: 'screen' as const,
            text: assessment.activity,
            at: Date.now(),
            interruptible: assessment.interruptible,
            ...(assessment.reason ? { reason: assessment.reason } : {}),
          }]
        }

        // 模型没按 JSON 答：退回一行描述，并把裁决权交回 mind（它有自己的关键词兜底）。
        const line = raw.replace(/\s+/g, ' ').trim()
        return line ? [{ kind: 'screen' as const, text: line.slice(0, 300), at: Date.now() }] : []
      }
      catch (error) {
        last = { stage: 'threw', error: String((error as Error)?.message ?? error).slice(0, 200), at: Date.now() }
        return []
      }
      finally {
        busy = false
      }
    },
  }
}
