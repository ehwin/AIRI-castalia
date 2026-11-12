import { createContext, defineInvoke } from '@moeru/eventa'
import { powerMonitor } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { systemPresenceGet } from '../../../shared/eventa/presence'
import { setupSystemPresence } from './system-presence'

vi.mock('electron', () => ({
  powerMonitor: {
    getSystemIdleState: vi.fn(),
    getSystemIdleTime: vi.fn(),
  },
}))

/** 全链路的那一头：渲染进程问一次系统状态，主进程用 powerMonitor 答一次。 */
function setupPresence() {
  const context = createContext()
  setupSystemPresence(context as never)
  return defineInvoke(context, systemPresenceGet)
}

describe('system presence service', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-11T15:00:00+08:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('passes the locked state through, because that is the only hard fact', async () => {
    vi.mocked(powerMonitor.getSystemIdleState).mockReturnValue('locked')
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(30)

    await expect(setupPresence()()).resolves.toEqual({
      state: 'locked',
      idleSeconds: 30,
      at: Date.now(),
    })
  })

  it('reports a long idle time without turning it into "away"', async () => {
    // 读了半小时文档：键鼠不动，人还在。
    vi.mocked(powerMonitor.getSystemIdleState).mockReturnValue('idle')
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(30 * 60)

    const reading = await setupPresence()()
    expect(reading.state).toBe('idle')
    expect(reading.idleSeconds).toBe(1800)
  })

  it('asks the system with the same threshold it documents', async () => {
    vi.mocked(powerMonitor.getSystemIdleState).mockReturnValue('active')
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(0)

    await setupPresence()()
    expect(powerMonitor.getSystemIdleState).toHaveBeenCalledWith(600)
  })

  it('keeps an unknown state unknown instead of guessing', async () => {
    vi.mocked(powerMonitor.getSystemIdleState).mockReturnValue('unknown')
    vi.mocked(powerMonitor.getSystemIdleTime).mockReturnValue(0)

    await expect(setupPresence()()).resolves.toMatchObject({ state: 'unknown' })
  })
})
