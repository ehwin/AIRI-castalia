// 「类人」性质的断言 —— 不断言具体数字，只断言四条可证伪的性质。
// 依据：
//  - 负性偏向：Baumeister et al. 2001, "Bad is stronger than good"
//  - 情绪惯性：Kuppens et al. 2010, emotional inertia（状态自相关）
//  - 重要性/反刍决定持续时间：Verduyn & Lavrijsen 2014, "Which emotions last longest and why"
//  - 饱和 + 单步限幅：Murmur 的三道闸（惯性 / 饱和 / 限幅）在生产里的写法
import type { PsycheTransitionOptions } from './vendor/engine/psycheState'

import { describe, expect, it } from 'vitest'
import {
  createPsycheState,
  readPsycheTuning,
  transitionPsycheState,
} from './vendor/engine/psycheState'

const HOUR = 3600_000
const t0 = Date.UTC(2026, 9, 31, 0, 0, 0)

function fresh() {
  return createPsycheState({}, t0)
}

/** 从当前状态推一个绝对目标，返回新状态。 */
function push(state: ReturnType<typeof fresh>, target: number, at: number, id: string, opts: PsycheTransitionOptions = {}) {
  return transitionPsycheState(
    state,
    { kind: 'target', target: { valence: target }, eventId: id },
    at,
    opts,
  )
}

/** 无事件地推进时间（只做衰减）。 */
function wait(state: ReturnType<typeof fresh>, hours: number, at: number) {
  return transitionPsycheState(state, { kind: 'no_event' }, at + hours * HOUR)
}

describe('类人性质：负性不对称', () => {
  it('同样距离的坏事件推得比好事件远', () => {
    const base = fresh().baseline.valence
    const s = fresh()
    const neg = push(s, base - 0.5, t0, 'n1')
    const pos = push(s, base + 0.5, t0, 'p1')
    const negDelta = Math.abs(neg.vad.valence - s.vad.valence)
    const posDelta = Math.abs(pos.vad.valence - s.vad.valence)
    expect(negDelta).toBeGreaterThan(posDelta * 1.1)
  })

  it('同样距离的坏事件留下的偏离衰减更慢', () => {
    const base = fresh().baseline.valence
    const s = fresh()
    const neg = wait(push(s, base - 0.4, t0, 'n2'), 24, t0)
    const pos = wait(push(s, base + 0.4, t0, 'p2'), 24, t0)
    const negFrac = Math.abs(neg.vad.valence - base) / 0.4
    const posFrac = Math.abs(pos.vad.valence - base) / 0.4
    expect(negFrac).toBeGreaterThan(posFrac * 1.2)
  })
})

describe('类人性质：情绪惯性', () => {
  it('已有负偏离时，正向证据的第一步被折价', () => {
    const base = fresh().baseline.valence
    const down = push(fresh(), base - 0.35, t0, 'down')
    const back = push(down, 1, t0 + 60_000, 'back').vad.valence - down.vad.valence
    // A/B：同一状态、同一目标，只关掉惯性
    const env = { ...process.env }
    process.env.PSYCHE_INERTIA = '1'
    let off: number
    try {
      off = push(down, 1, t0 + 60_000, 'back-off').vad.valence - down.vad.valence
    }
    finally {
      process.env = env
    }
    expect(back).toBeLessThan(off * 0.8)
    expect(back).toBeGreaterThan(0) // 惯性是打折，不是锁死
  })
})

describe('类人性质：饱和与单步限幅', () => {
  it('一次事件不能把状态推过单步上限', () => {
    const tuning = readPsycheTuning()
    const s = fresh()
    const jumped = push(s, 1, t0, 'cap', { eventGain: 1 })
    expect(Math.abs(jumped.vad.valence - s.vad.valence)).toBeLessThanOrEqual(tuning.maxStep + 1e-9)
  })

  it('一百次同向事件不越界，且边际位移递减', () => {
    let s = fresh()
    let prev = s.vad.valence
    const steps: number[] = []
    for (let i = 0; i < 100; i++) {
      s = push(s, 1, t0 + i * 1000, `e${i}`)
      steps.push(s.vad.valence - prev)
      prev = s.vad.valence
    }
    expect(s.vad.valence).toBeLessThanOrEqual(1)
    expect(Number.isFinite(s.vad.valence)).toBe(true)
    const early = steps.slice(0, 10).reduce((a, b) => a + b, 0)
    const late = steps.slice(-10).reduce((a, b) => a + b, 0)
    expect(late).toBeLessThan(early * 0.5)
  })
})

describe('类人性质：重要性延长持续时间', () => {
  it('同一事件，重要的那条 24 小时后留下更多偏离', () => {
    const base = fresh().baseline.valence
    const s = fresh()
    // salience 落在状态里（随被采纳的证据持久化），后续只做纯衰减也要生效
    const low = wait(push(s, base - 0.4, t0, 'lo', { salience: 0 }), 24, t0)
    const high = wait(push(s, base - 0.4, t0, 'hi', { salience: 1 }), 24, t0)
    const lowFrac = Math.abs(low.vad.valence - base)
    const highFrac = Math.abs(high.vad.valence - base)
    expect(highFrac).toBeGreaterThan(lowFrac * 1.2)
  })

  // ROOT CAUSE:
  // New salience changed decay before the new evidence arrived.
  // Decay must use the previous evidence's salience until the next event.
  it('新事件的重要性不改变它到来之前的衰减', () => {
    const initial = push(fresh(), -0.5, t0, 'initial', { salience: 0 })
    const nextAt = t0 + 4 * HOUR
    const direct = push(initial, -0.1, nextAt, 'next', { salience: 1 })
    const readFirst = push(wait(initial, 4, t0), -0.1, nextAt, 'next', { salience: 1 })

    expect(direct.vad.valence).toBeCloseTo(readFirst.vad.valence, 12)
    expect(direct.mood.valence).toBeCloseTo(readFirst.mood.valence, 12)
    expect(direct.salience).toBe(1)
  })

  it('重复或无效事件的重要性不改变衰减轨迹', () => {
    const initial = push(fresh(), -0.5, t0, 'initial', { salience: 0 })
    const nextAt = t0 + 4 * HOUR
    const expected = wait(initial, 4, t0)
    const duplicate = push(initial, -0.5, nextAt, 'initial', { salience: 1 })
    const invalid = transitionPsycheState(initial, { kind: 'invalid' }, nextAt, { salience: 1 })

    expect(duplicate.vad).toEqual(expected.vad)
    expect(invalid.vad).toEqual(expected.vad)
    expect(duplicate.salience).toBe(initial.salience)
    expect(invalid.salience).toBe(initial.salience)
  })
})

describe('回归：确定性边界没被类人项破坏', () => {
  it('neutral 不改 VAD', () => {
    const s = fresh()
    const after = transitionPsycheState(s, { kind: 'neutral', eventId: 'x' }, t0 + 1000)
    expect(after.vad).toEqual(s.vad)
  })

  it('state_neutral 向人格基线走，不向 0 走', () => {
    const s = fresh()
    const down = push(s, -0.2, t0, 'd')
    const back = transitionPsycheState(down, { kind: 'state_neutral', eventId: 'sn' }, t0 + 1000)
    expect(back.vad.valence).toBeGreaterThan(down.vad.valence)
    expect(back.vad.valence).toBeLessThan(s.baseline.valence + 1e-9)
  })

  it('首次 state_neutral 观测会建立互动证据', () => {
    const observedAt = t0 + 1000
    const after = transitionPsycheState(
      fresh(),
      { kind: 'state_neutral', eventId: 'baseline-observation' },
      observedAt,
    )

    expect(after.hasEvidence).toBe(true)
    expect(after.lastEvidenceAt).toBe(observedAt)
  })

  it('过期证据的重复事件不会重新建立证据', () => {
    const evidenceTtlHours = 1
    const initial = transitionPsycheState(
      fresh(),
      { kind: 'target', target: { valence: -0.5 }, eventId: 'expired-event' },
      t0,
      { evidenceTtlHours },
    )
    const expired = transitionPsycheState(
      initial,
      { kind: 'no_event' },
      t0 + 2 * HOUR,
      { evidenceTtlHours },
    )
    const replayed = transitionPsycheState(
      expired,
      { kind: 'target', target: { valence: -0.5 }, eventId: 'expired-event' },
      t0 + 2 * HOUR + 1000,
      { evidenceTtlHours },
    )

    expect(expired.hasEvidence).toBe(false)
    expect(replayed.hasEvidence).toBe(false)
    expect(replayed.lastEvidenceAt).toBe(t0)
  })

  it('重复 eventId 不产生第二次位移', () => {
    const s = fresh()
    const once = push(s, 0.9, t0, 'dup')
    const twice = push(once, 0.9, t0, 'dup')
    expect(twice.vad.valence).toBe(once.vad.valence)
  })

  it('关闭类人项后与旧公式逐位一致', () => {
    const s = createPsycheState({ valence: 0.4, arousal: 0.3, dominance: 0.6 }, t0)
    const env = { ...process.env }
    Object.assign(process.env, {
      PSYCHE_NEGATIVE_IMPACT: '1',
      PSYCHE_NEGATIVE_PERSISTENCE: '1',
      PSYCHE_INERTIA: '1',
      PSYCHE_SATURATION: '0',
      PSYCHE_MAX_STEP: '1',
      PSYCHE_SALIENCE_PERSISTENCE: '0',
    })
    try {
      const target = transitionPsycheState(s, { kind: 'target', target: { valence: -0.2 }, eventId: 'old' }, t0 + 1000)
      // 旧公式：decayed 后线性走到目标的 55%
      const expected = 0.4 + 0.55 * (-0.2 - 0.4)
      expect(target.vad.valence).toBeCloseTo(expected, 12)
    }
    finally {
      process.env = env
    }
  })
})
