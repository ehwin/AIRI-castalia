/**
 * 主人此刻在不在、忙不忙。
 *
 * 两路证据，但只有一路能回答「忙不忙」：
 *
 * - 锁屏（`PresenceReading`）：主进程一问就有。它是唯一可靠的「人不在」。
 * - 屏幕裁决（视觉）：看一眼画面，能说出「在开会 / 在写代码 / 在看视频」。
 *   这是判断忙闲的唯一一路；慢、会失败，失败时结论就是「不知道」。
 *
 * 空闲时长不算证据。键鼠十分钟没动，可以是在读文档、开会、看演示——恰好是
 * 最不该被打断的状态。用「有没有输入」推断「忙不忙」，与用「有没有人说话」
 * 推断头脑里有没有在做事是同一种错误。
 *
 * 真正要修的不是感知不够，而是把「不知道」当成了「可以打扰」：问一句
 * 「你在忙吗」正是这个缺口的产物。所以 `unknown` 与 `free` 词句不同——
 * `free` 让她直接说事，`unknown` 只允许说她自己想到的。
 *
 * 依据：Horvitz et al. 1999（NEVA：打扰的代价与沉默的代价两侧定价）；
 * Iqbal & Horvitz 2007（一次打扰的真实代价约 20 分钟，27% 的窗口两小时内
 * 不再回来）；Pejović & Musolesi 2014（连续打扰比随机更差，代价路径相关）；
 * Pielot et al. 2017（用户自己的响应历史比全部上下文特征更有用）。
 */
import { screenSummary } from './inner-voice'

/** 系统空闲/锁屏这一路的读数。 */
export type PresenceState = 'active' | 'idle' | 'locked' | 'unknown'

export interface PresenceReading {
  state: PresenceState
  /** 距最后一次键鼠输入的秒数，读不到时不给。 */
  idleSeconds?: number
  /** 读数的时间，用来判断它有没有过期。 */
  at: number
}

/**
 * `away` 与 `busy` 都不出声，但理由不同：一个没人在，一个在忙。
 * 分开写是为了让她心里那句话不同（「他不在」不是「他在忙」）。
 */
export type InterruptionLevel = 'away' | 'busy' | 'free' | 'unknown'

export interface InterruptionVerdict {
  level: InterruptionLevel
  /** 给诊断看的原因，不直接渲染。 */
  reason?: string
  /** 一句平铺直叙的话，进运行时上下文；没有感知能力时为 undefined。 */
  line?: string
}

export interface InterruptionInput {
  presence?: PresenceReading
  screen?: {
    /** 视觉模型对画面的那一句描述。 */
    activity?: string
    /** 视觉模型的裁决；undefined 表示它没给意见。 */
    interruptible?: boolean
    reason?: string
    /** 这条裁决有多久了。 */
    ageMs?: number
    /**
     * 只接受比这更新的裁决。
     *
     * 开口那一刻必须传它：`free` 是一句「他现在不忙」的断言，只有刚刚这一眼
     * 看到的东西能支撑。看一眼超时、或视觉只回了描述没回裁决时，旧的那条
     * `free` 不能拿来当许可。
     */
    minAgeMs?: number
  }
  /** 屏幕裁决超过这个岁数就不再描述此刻。 */
  screenTtlMs?: number
}

/** 视觉裁决的有效期。和 `self-initiated-speech` 的屏幕判断保持同一个量级。 */
export const SCREEN_VERDICT_TTL_MS = 15 * 60_000

/**
 * 合成两路证据。
 *
 * 顺序是：锁屏 > 屏幕裁决 > 不知道。
 *
 * **空闲时长不参与「忙不忙」的判断**。键鼠十分钟没动，可以是走开了，也可以是
 * 在读文档、开会、看别人演示——后者正是这个人最常处、也最不该被打断的状态。
 * OS 的空闲计数只说明「没输入」，不说明「不忙」；把它当 busy/away 的替代品，
 * 等于用「有没有人说话」去推断头脑里有没有在做事。判断忙闲只有视觉这一路。
 *
 * 锁屏是唯一的硬事实：屏幕锁着时视觉看到的是壁纸，它说「可以打扰」也不算数。
 */
export function interruptionVerdict(input: InterruptionInput): InterruptionVerdict {
  const presence = input.presence
  const activity = screenSummary(input.screen?.activity, 60)
  // 两个上限取小的：有效期，以及调用方要求的「必须是这一眼」。下限 1 秒，
  // 因为一次 look 本身要花几秒，`minAgeMs` 可以小到 0。
  const ttl = Math.min(
    input.screenTtlMs ?? SCREEN_VERDICT_TTL_MS,
    Math.max(1_000, input.screen?.minAgeMs ?? Number.POSITIVE_INFINITY),
  )

  if (presence?.state === 'locked')
    return { level: 'away', reason: 'screen-locked', line: '主人锁屏了，人不在电脑前。别自己起话头，也别问他在不在忙。' }

  const age = input.screen?.ageMs
  const fresh = typeof age === 'number' && age >= 0 && age <= ttl
  if (fresh && typeof input.screen?.interruptible === 'boolean') {
    if (!input.screen.interruptible) {
      const what = activity ? `屏幕上${activity}` : '屏幕上像在忙'
      // 「别自己起话头」而不是「别打扰」：这一句也会进普通对话的运行时上下文。
      // 主人主动说话时他就是在找你，写成「别打扰」会让模型把该回的话也咽回去。
      return { level: 'busy', reason: input.screen.reason ?? 'busy-screen', line: `${what}，他像是在忙，别自己起话头，也别问他在不在忙。` }
    }
    const what = activity ? `屏幕上：${activity}。` : ''
    return {
      level: 'free',
      reason: input.screen.reason ?? 'interruptible',
      line: `${what}看起来可以说话——直接说你的事，别问他在不在忙。`,
    }
  }

  // 没锁屏、也没看见：既不能说忙，也不能说不忙。只要她敢开口，就只能说自己的事。
  return {
    level: 'unknown',
    reason: 'no-screen-verdict',
    line: '你看不到屏幕，也不知道主人忙不忙。别问他在不在忙；要说就说你自己此刻想到的事。',
  }
}

/**
 * 这句话是不是在问主人忙不忙。
 *
 * 只给诊断用：模型偶尔仍会问，那说明上下文没压住它，需要在面板上看得见，
 * 而不是靠猜。不拦截、不改写——改写一句已经生成的话，比多问一句更假。
 */
export function asksIfBusy(text: string): boolean {
  const value = String(text ?? '').trim()
  if (!value)
    return false
  if (/\b(?:are|you|u)\s+(?:you\s+)?busy\b/iu.test(value))
    return true
  return /在忙吗|忙不忙|是不是在忙|在不在忙|你忙吗|您忙吗|有空吗|有时间吗|方便说话吗|打扰到你/u.test(value)
}
