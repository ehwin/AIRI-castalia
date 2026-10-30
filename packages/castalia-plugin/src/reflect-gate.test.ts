import { afterEach, describe, expect, it } from 'vitest'

import { injectionMinSimilarityReflect, isReflectDerived } from './vendor/engine/recallForInjection'

// 背景(2026-10-29 实测):在 airi 库副本上开启抽取+整合后,is_active 从 160 涨到 182、facts +14,
// 但噪音问句「下周要交的报表怎么做」以 0.540 命中一条「汇报偏好」摘要,噪音从 0/8 变成 1/8。
// 那条摘要的来源是 `reflect_merge`(整合合并产出的稠密改写),不是原文 —— 所以反刍行要单独的门槛。
describe('reflect-derived rows', () => {
  afterEach(() => {
    delete process.env.MEMORY_INJECT_MIN_SIM_REFLECT
  })

  it('covers every producer, including merges', () => {
    // 这里刻意用前缀判定:第一版枚举了 extract/insight/summary/reasoning 四个,
    // 恰好漏掉 reflect_merge,而漏掉的那一种正是把噪音带进注入的那一条。
    for (const source of ['reflect_extract', 'reflect_insight', 'reflect_summary', 'reflect_reasoning', 'reflect_merge', 'daily_event'])
      expect(isReflectDerived({ source })).toBe(true)
  })

  it('treats event summaries as rewrites too', () => {
    // 实测：「团子怎么了」对事件行 0.606，噪音「下周要交的报表怎么做」对「下周三复查提醒」0.587。
    // 两者只差 0.019，所以事件行必须和 reflect_* 一样走 0.60 门槛，不能按原文 0.45/0.50 放行。
    expect(isReflectDerived({ source: 'daily_event' })).toBe(true)
    expect(injectionMinSimilarityReflect()).toBeGreaterThanOrEqual(0.6)
  })

  it('leaves original rows on the normal gate', () => {
    for (const source of ['manual_lore', 'manual', 'conversation_log', 'session_promoted', 'agent_state', null, undefined])
      expect(isReflectDerived({ source })).toBe(false)
  })

  it('defaults to 0.60 and honours the env override', () => {
    expect(injectionMinSimilarityReflect()).toBe(0.6)
    process.env.MEMORY_INJECT_MIN_SIM_REFLECT = '0.66'
    expect(injectionMinSimilarityReflect()).toBe(0.66)
    process.env.MEMORY_INJECT_MIN_SIM_REFLECT = 'not-a-number'
    expect(injectionMinSimilarityReflect()).toBe(0.6)
  })
})
