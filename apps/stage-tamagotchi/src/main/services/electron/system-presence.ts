import type { createContext } from '@moeru/eventa/adapters/electron/main'

import { defineInvokeHandler } from '@moeru/eventa'
import { powerMonitor } from 'electron'

import { systemPresenceGet } from '../../../shared/eventa/presence'

/**
 * 系统在多少秒无输入之后报 `idle`。
 *
 * 只为读数对齐：这个数不参与「忙不忙」的判断（见 `interruptionVerdict`），
 * 主进程也不为此引整个 core-agent 包。
 */
const IDLE_THRESHOLD_SECONDS = 10 * 60

/**
 * 主人此刻在不在电脑前。
 *
 * 只读一次系统状态，不抓屏、不进模型：心智 tick 每 45 秒问一次也不心疼。
 *
 * **它只回答「锁没锁屏」，不回答「忙不忙」。** 空闲时长一并带出去给面板看，
 * 但空闲不等于离开，更不等于闲着：读文档、开会、看演示时键鼠可以长时间不动。
 * 忙闲由视觉那一句裁决——这里多给一分「推断」，就会多一次误判。
 */
export function setupSystemPresence(context: ReturnType<typeof createContext>['context']) {
  defineInvokeHandler(context, systemPresenceGet, () => ({
    state: powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS),
    idleSeconds: powerMonitor.getSystemIdleTime(),
    at: Date.now(),
  }))
}
