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
  /** Display layout hardly changes; re-reading it every look would cost an extra CLI run each time. */
  let displays: Array<{ name: string, isPrimary: boolean, frame: { x: number, y: number, w: number, h: number }, logical: { x: number, y: number, w: number, h: number }, scale: number }> = []
  let displaysAt = 0

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

  function parseJson(output: unknown): any {
    return typeof output === 'string' ? JSON.parse(output) : output
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

        // 哪一块屏？光标所在的那块。人眼跟着手走，比"主屏"这个静态概念更接近她该看的地方，
        // 也是唯一能把第二块屏带进来的路（`display.capture` 只认主屏，`Target forbidden`）。
        if (Date.now() - displaysAt > 5 * 60_000) {
          const listed = await run({ argv: ['invoke', 'display.list', '--json'] })
          const parsed = parseJson(listed?.output)
          const rows = Array.isArray(parsed?.result?.displays) ? parsed.result.displays : []
          displays = rows.map((row: any) => {
            const scale = Number(row?.scale_factor ?? 1) || 1
            const frame = {
              x: Number(row?.frame?.origin?.x ?? 0),
              y: Number(row?.frame?.origin?.y ?? 0),
              w: Number(row?.frame?.size?.width ?? 0),
              h: Number(row?.frame?.size?.height ?? 0),
            }
            // `display.list` 的 frame 是物理像素，光标是逻辑坐标：命中测试必须换算到
            // 同一空间，否则两块屏缩放不同（1.5 / 1.25）时右边那块会被判成左边的。
            return {
              name: String(row?.name ?? 'display'),
              isPrimary: row?.is_primary === true,
              frame,
              logical: { x: frame.x / scale, y: frame.y / scale, w: frame.w / scale, h: frame.h / scale },
              scale,
            }
          }).filter((row: { logical: { w: number, h: number } }) => row.logical.w > 0 && row.logical.h > 0)
          displaysAt = Date.now()
          last = { ...last, displays: displays.map(d => ({ name: d.name, frame: d.frame, logical: d.logical, scale: d.scale })) }
        }

        let pointer: { x: number, y: number } | undefined
        try {
          const pos = await run({ argv: ['invoke', 'input.pointerPosition', '--json'] })
          const parsed = parseJson(pos?.output)
          const result = parsed?.result ?? parsed
          if (Number.isFinite(result?.x) && Number.isFinite(result?.y))
            pointer = { x: Number(result.x), y: Number(result.y) }
        }
        catch { /* 光标读不到就退回主屏 */ }

        const target = pointer
          ? displays.find(d => pointer!.x >= d.logical.x && pointer!.x < d.logical.x + d.logical.w
            && pointer!.y >= d.logical.y && pointer!.y < d.logical.y + d.logical.h)
          : undefined
        const chosen = target ?? displays.find(d => d.isPrimary) ?? displays[0]

        // 副屏只能按逻辑矩形抓（AUV 没有"抓第 N 块屏"的参数），主屏走物理分辨率的整屏抓。
        let capture: any
        let route = 'display.capture'
        if (chosen && !chosen.isPrimary) {
          route = 'screen.captureRegion'
          capture = await run({
            // 负坐标必须写成 `--x=-1920`：分写时 clap 会把 `-1920` 当成新的旗标，
            // 报 `invalid value '--x' ... invalid float literal`。左副屏的 x 恒为负，踩过。
            argv: [
              'invoke',
              'screen.captureRegion',
              `--x=${Math.round(chosen.logical.x)}`,
              `--y=${Math.round(chosen.logical.y)}`,
              `--width=${Math.round(chosen.logical.w)}`,
              `--height=${Math.round(chosen.logical.h)}`,
              '--json',
            ],
          })
        }
        else {
          capture = await run({ argv: ['invoke', 'display.capture', '--json'] })
        }

        last = { ...last, stage: 'capture', route, display: chosen?.name, pointer, exitCode: capture?.exitCode, at: Date.now() }
        if (capture?.exitCode !== 0)
          return []

        const parsedCapture = parseJson(capture.output)
        const artifactPath = parsedCapture?.artifacts?.[0]?.file_path
        const pixels = parsedCapture?.result?.capture?.pixel_dimensions
        last = { ...last, stage: 'artifact', hasPath: Boolean(artifactPath), pixels }
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
