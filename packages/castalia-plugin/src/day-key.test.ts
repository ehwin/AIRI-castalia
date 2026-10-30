import { describe, expect, it } from 'vitest'

import { localDayOf, localDayOffset } from './vendor/engine/dayKey'
import { temporalDaysOf } from './vendor/engine/recallForInjection'

/**
 * 引擎镜像的日历日口径（Castalia-Anima 2026-10-30 修复的钉子）。
 *
 * 事件层按天分桶与「今天/昨天」取日必须同口径，否则 UTC+8 下本地 00:00–08:00 的对话
 * 被算进前一天，"今天在忙什么"查不到自己凌晨那段（真实样本 2026-10-29T17:03Z = 本地 10-30 01:03）。
 */
describe('day key', () => {
  it('本地 00:30 属于今天，不是 UTC 的前一天', () => {
    const local = new Date()
    local.setHours(0, 30, 0, 0)
    expect(localDayOf(local.toISOString())).toBe(localDayOffset(0))
  })

  it('时间路取日与分桶走同一个函数', () => {
    expect([...temporalDaysOf('今天在忙什么')]).toEqual([localDayOffset(0)])
    expect([...temporalDaysOf('昨天忙什么')]).toEqual([localDayOffset(1)])
    expect([...temporalDaysOf('前两天呢')].sort()).toEqual(
      [localDayOffset(0), localDayOffset(1), localDayOffset(2)].sort(),
    )
    expect([...temporalDaysOf('帮我写个快速排序')]).toEqual([])
  })
})
