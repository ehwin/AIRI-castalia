import { defineInvokeEventa } from '@moeru/eventa'

/**
 * 主人此刻在不在电脑前。
 *
 * 这是廉价的一路：主进程读一次系统空闲与锁屏就有，不进模型、不抓屏。视觉那条
 * 又慢又会失败，只适合回答「他在干什么」；「在不在」不该问视觉。
 *
 * `state` 直接沿用 Electron `powerMonitor.getSystemIdleState` 的词表。
 */
export interface SystemPresence {
  state: 'active' | 'idle' | 'locked' | 'unknown'
  /** 距最后一次键鼠输入的秒数。 */
  idleSeconds: number
  at: number
}

export const systemPresenceGet = defineInvokeEventa<SystemPresence>('eventa:invoke:electron:system-presence:get')
