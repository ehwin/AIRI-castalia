// 定向回归：psyche 状态机里两处「时间与证据」的错位。
//
// 两条都只在「读一次」和「不读」之间出现差别，所以用同一个初始状态走两条路径对比，
// 而不是拿一堆断言钉住某次演算出的数字。
import { describe, expect, it } from 'vitest'

import { createPsycheState, transitionPsycheState } from './vendor/engine/psycheState'

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
const HOUR = 3600000

describe('重要性只能影响它到来之后的衰减', () => {
  // 旧行为：过去的四小时用「新事件的重要性」去算，于是同一初始状态「等四小时再应用事件」
  // 和「先读一次再应用同一事件」得到两条轨迹，重放/无效事件携带的 salience 也能改写历史。
  it('同一段时间的衰减不随新事件的 importance 改变', () => {
    const base = createPsycheState({}, T0)
    const withEvidence = transitionPsycheState(base, { kind: 'event', delta: { valence: 0.5 }, eventId: 'e1' }, T0, { salience: 0.9 })

    // 同一个事件 id 的重放：不推进状态，只走衰减。
    const quiet = transitionPsycheState(withEvidence, { kind: 'event', delta: { valence: 0.5 }, eventId: 'e1' }, T0 + 4 * HOUR, { salience: 0 })
    const loud = transitionPsycheState(withEvidence, { kind: 'event', delta: { valence: 0.5 }, eventId: 'e1' }, T0 + 4 * HOUR, { salience: 1 })

    expect(loud.version).toBe(quiet.version)
    expect(loud.vad.valence).toBeCloseTo(quiet.vad.valence, 10)
    expect(loud.vad.arousal).toBeCloseTo(quiet.vad.arousal, 10)
  })
})

describe('过期证据不能被重放点亮', () => {
  it('重放同一条事件不会让 hasEvidence 回到 true', () => {
    const base = createPsycheState({}, T0)
    const applied = transitionPsycheState(base, { kind: 'event', delta: { valence: 0.6 }, eventId: 'e2' }, T0, { evidenceTtlHours: 1 })
    expect(applied.hasEvidence).toBe(true)

    // 两小时后：证据过期，可见情绪回到中性。
    const expired = transitionPsycheState(applied, { kind: 'unknown' }, T0 + 2 * HOUR, { evidenceTtlHours: 1 })
    expect(expired.hasEvidence).toBe(false)

    // 同一 id 的重放没有更新证据时间，因此不能把 hasEvidence 翻回 true。
    const replayed = transitionPsycheState(expired, { kind: 'event', delta: { valence: 0.6 }, eventId: 'e2' }, T0 + 2 * HOUR + 60000, { evidenceTtlHours: 1 })
    expect(replayed.hasEvidence).toBe(false)
    expect(replayed.lastEvidenceAt).toBe(expired.lastEvidenceAt)
  })
})
