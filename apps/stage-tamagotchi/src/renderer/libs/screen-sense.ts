import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { parseActivityAssessment } from '@proj-airi/core-agent'
import { useVisionOrchestratorStore } from '@proj-airi/stage-ui/stores/modules/vision'

import { computerUseReadImage, computerUseRun } from '../../shared/eventa/computer-use'
import { systemPresenceGet } from '../../shared/eventa/presence'
import { downscaleForVision } from './image-downscale'

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

export function createScreenSense() {
  let busy = false
  /** 单条 AUV 命令的上限。截图只要几秒，45 秒还没回就是坏了。 */
  const LOOK_COMMAND_TIMEOUT_MS = 45_000
  /** 最近一次 look 走到哪一步、拿到什么。没有它，「她看不见」和「她坏了」长得一模一样。 */
  let last: Record<string, unknown> = { stage: 'idle' }
  /** 廉价那一路的缓存：3 秒内的重复调用不必再问一次主进程。 */
  let presenceAt = 0
  let presenceValue: { state: 'active' | 'idle' | 'locked' | 'unknown', idleSeconds?: number, at: number } = { state: 'unknown', at: 0 }
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
    /**
     * 廉价的一路：主人在不在电脑前。
     *
     * 一次 IPC 读系统空闲与锁屏，不抓屏、不进模型。心智每 45 秒问一次也不心疼，
     * 而视觉那条要起截图和视觉调用——问「他在不在」用它既慢又浪费，还会把
     * 「看不见」当成「不忙」。
     */
    async presence() {
      const now = Date.now()
      // 3 秒缓存：同一跳里可能被 tick 与筛选各问一次，重复问没有意义。
      if (now - presenceAt < 3_000)
        return presenceValue
      presenceAt = now
      try {
        const { context } = createContext(window.electron.ipcRenderer)
        const get = defineInvoke(context, systemPresenceGet)
        // handler 还没注册时 `defineInvoke` 不会拒绝、只会一直等。不中断的话，每 45 秒会多留
        // 一对永不回收的监听器；abort signal 让 2 秒后连监听器一起清掉。
        const reading = await get(undefined, { signal: AbortSignal.timeout(2_000) })
        presenceValue = { state: reading.state, idleSeconds: reading.idleSeconds, at: reading.at }
      }
      catch {
        // 读不到就是不知道，不是「在场」：上层会把 unknown 当成「别问忙不忙」。
        presenceValue = { state: 'unknown', at: now }
      }
      return presenceValue
    },
    async look(): Promise<ScreenSenseObservation[]> {
      if (busy)
        return []
      busy = true
      const startedAt = Date.now()
      // AUV 是外部进程：它不回话时这一眼会永远挂着，`busy` 也就永远不会清——她就彻底失明。
      // 每条命令都有上限，超时中断，并把这一眼当作「没看见」。
      const abort = new AbortController()
      const watchdog = setTimeout(() => abort.abort(), LOOK_COMMAND_TIMEOUT_MS)
      try {
        const { context } = createContext(window.electron.ipcRenderer)
        const run = defineInvoke(context, computerUseRun)
        const readImage = defineInvoke(context, computerUseReadImage)

        // 哪一块屏？光标所在的那块。人眼跟着手走，比"主屏"这个静态概念更接近她该看的地方，
        // 也是唯一能把第二块屏带进来的路（`display.capture` 只认主屏，`Target forbidden`）。
        if (Date.now() - displaysAt > 5 * 60_000) {
          const listed = await run({ argv: ['invoke', 'display.list', '--json'] }, { signal: abort.signal })
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
          const pos = await run({ argv: ['invoke', 'input.pointerPosition', '--json'] }, { signal: abort.signal })
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
          }, { signal: abort.signal })
        }
        else {
          capture = await run({ argv: ['invoke', 'display.capture', '--json'] }, { signal: abort.signal })
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

        const imageDataUrl = await readImage({ path: artifactPath }, { signal: abort.signal })
        // 决策只要认得出「在开会 / 在写代码 / 全屏游戏」，不需要 4K 像素。
        // 原图按面积计费、还要走一遍传输，4K 换成 1280 宽省下的 token 与时间都有几倍。
        const visionImage = await downscaleForVision(imageDataUrl)

        // `screen:activity` 一次问清两件事：他在干什么（activity）+ 现在能不能打扰（interruptible）。
        // 之前用 `screen:interpret` 只得到一段画面描述，再靠关键词猜忙不忙——那条路没有下限。
        let workload: 'screen:activity' | 'screen:interpret' = 'screen:activity'
        let raw = ''
        try {
          raw = await ask(visionImage, workload)
        }
        catch (error) {
          last = { ...last, stage: 'activity-threw', error: String((error as Error)?.message ?? error).slice(0, 160) }
        }

        // 新工作负载没答上来（模型不认、返回空、请求被拒）就退回旧的描述型工作负载，
        // 至少留一行能看的画面：感知断掉比描述粗糙更糟。
        if (!raw) {
          workload = 'screen:interpret'
          try {
            raw = await ask(visionImage, workload)
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
        clearTimeout(watchdog)
        busy = false
        // 一次 look 花了多久：超时预算（`LOOK_BUDGET_MS`）够不够，面板上看这个数，
        // 不要靠猜。
        last = { ...last, elapsedMs: Date.now() - startedAt }
      }
    },
  }
}
