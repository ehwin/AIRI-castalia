import type { PsycheState } from './vendor/engine/psycheState'

// 两层（快情绪 + 慢心境）的性质测试。
//
// 参数来源：E2 / R10 —— CoVidAffect 121 人的真实序列上，两层拟合得到
// 快层 τf≈2.85h、慢层 τs≈66h（单层 OU 中位 2.34h）。这里断言的是**结构**
// 是否成立，不是复核那两个数字：
//   1) 冲击只推情绪，不瞬间改心境；
//   2) 情绪几小时内淡出，心境整天还在；
//   3) 心境最后仍回到人格基线（不会永久漂移）；
//   4) 关闭慢层时精确退化回单层（A/B 开关）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createPsycheState,
  transitionPsycheState,
} from './vendor/engine/psycheState'

const HOUR = 3600_000
const t0 = Date.UTC(2026, 10, 1, 0, 0, 0)

function fresh() {
  return createPsycheState({}, t0)
}

function shock(state: ReturnType<typeof fresh>, delta: number, at = t0) {
  return transitionPsycheState(state, { kind: 'event', delta: { valence: delta }, eventId: `e${Math.random()}` }, at)
}

function wait(state: ReturnType<typeof fresh>, hours: number, from = t0) {
  return transitionPsycheState(state, { kind: 'no_event' }, from + hours * HOUR)
}

/**
 * The slow layer is off by default (product decision, see DEFAULT_MOOD_HALF_LIFE).
 * These tests are about the two-layer structure itself, so they switch it on
 * with the fitted constants from E2.
 */
function enableSlowLayer() {
  process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS = '45.75'
  process.env.PSYCHE_MOOD_HALF_LIFE_AROUSAL_HOURS = '16'
  process.env.PSYCHE_MOOD_HALF_LIFE_DOMINANCE_HOURS = '144'
}

const MOOD_ENV = [
  'PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS',
  'PSYCHE_MOOD_HALF_LIFE_AROUSAL_HOURS',
  'PSYCHE_MOOD_HALF_LIFE_DOMINANCE_HOURS',
]

afterEach(() => {
  for (const k of MOOD_ENV) delete process.env[k]
})

describe('band 中心：默认是旧语义（中心=人格基线），标定走部署配置', () => {
  it('默认中心下，一次中等正向证据还不足以进入 positive', () => {
    const s = transitionPsycheState(fresh(), { kind: 'event', delta: { valence: 0.2 }, eventId: 'b1' }, t0)
    expect(s.band).toBe('neutral')
  })

  it('cPED 那组标定（中心 −0.35、宽 0.12）下同一证据进入 positive', () => {
    process.env.PSYCHE_BAND_CENTER_OFFSET = '-0.35'
    process.env.PSYCHE_BAND_ENTER = '0.12'
    process.env.PSYCHE_BAND_HOLD = '0.05'
    const s = transitionPsycheState(fresh(), { kind: 'event', delta: { valence: 0.2 }, eventId: 'b2' }, t0)
    expect(s.band).toBe('positive')
    delete process.env.PSYCHE_BAND_CENTER_OFFSET
    delete process.env.PSYCHE_BAND_ENTER
    delete process.env.PSYCHE_BAND_HOLD
  })
})

describe('两层动力学：结构而不是常数', () => {
  beforeEach(enableSlowLayer)

  it('冲击只推情绪，心境在同一步里不动', () => {
    const s = fresh()
    const b = s.baseline.valence
    expect(s.mood.valence).toBeCloseTo(b, 12)

    const after = shock(s, -0.6)
    expect(after.vad.valence).toBeLessThan(b - 0.15)
    expect(after.mood.valence).toBeCloseTo(b, 12)
  })

  it('3 小时后心境只跟着走一小步（< 情绪偏离的 10%）', () => {
    const b = fresh().baseline.valence
    const s = wait(shock(fresh(), -0.6), 3)
    const vadDev = Math.abs(s.vad.valence - b)
    const moodDev = Math.abs(s.mood.valence - b)
    expect(vadDev).toBeGreaterThan(0.1)
    expect(moodDev).toBeLessThan(vadDev * 0.1)
  })

  it('24 小时后仍有余温，而单层实现已经回到基线', () => {
    const b = fresh().baseline.valence
    const layered = wait(shock(fresh(), -0.6), 24)
    // The exact two-layer solution leaves ~0.011 after a day. The old >0.03
    // threshold was measured through the one-shot splitting step, which
    // over-retained; the dense-read value is the real one.
    expect(Math.abs(layered.mood.valence - b)).toBeGreaterThan(0.005)
    expect(Math.abs(layered.mood.valence - b)).toBeLessThan(0.05)

    // 关闭慢层 = 旧的单层实现：情绪直接回基线，不留余温。
    for (const k of MOOD_ENV) process.env[k] = '0'
    const single = wait(shock(fresh(), -0.6), 24)
    expect(Math.abs(single.vad.valence - b)).toBeLessThan(0.02)
    expect(Math.abs(single.mood.valence - single.vad.valence)).toBeLessThan(1e-9)
  })

  it('一周内心境回到基线附近（不永久漂移）', () => {
    const b = fresh().baseline.valence
    const s = wait(shock(fresh(), -0.6), 24 * 7)
    expect(Math.abs(s.mood.valence - b)).toBeLessThan(0.05)
  })

  it('快层半衰期跟随常量：H=1.97h 时 3 小时后偏离剩 0.5^(3/1.97)≈0.35', () => {
    // 关掉慢层再断言：两层结构下快层朝心境回归，比例不是纯半衰期。
    for (const k of MOOD_ENV) process.env[k] = '0'
    const b = fresh().baseline.valence
    const s0 = shock(fresh(), 0.6)
    const dev0 = s0.vad.valence - b
    expect(dev0).toBeGreaterThan(0.1)
    const s3 = wait(s0, 3)
    const ratio = (s3.vad.valence - b) / dev0
    // E2 拟合的是 τ=2.85h；decay() 的 2^(−dt/H) 要的是 H=τ·ln2=1.97h。
    // 这一条守的就是「别再有人把 τ 直接填进 H」。
    const expected = 0.5 ** (3 / 1.97)
    expect(ratio).toBeGreaterThan(expected - 0.03)
    expect(ratio).toBeLessThan(expected + 0.03)
  })

  it('慢层可由环境变量覆盖：调短后余温更快消失', () => {
    const base = fresh()
    const b = base.baseline.valence
    // Isolate the slow layer: the emotion sits on the baseline, only the mood
    // is displaced. With the fast layer also moving, the coupling limits how
    // fast the mood can follow and the comparison stops being about the knob.
    const moodOnly = {
      ...base,
      vad: { ...base.baseline },
      mood: { ...base.baseline, valence: b - 0.6 },
    }
    const slow = wait(moodOnly, 24)
    process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS = '2'
    const fast = wait(moodOnly, 24)
    expect(Math.abs(fast.mood.valence - b)).toBeLessThan(Math.abs(slow.mood.valence - b) / 2)
  })
})

describe('the slow layer is off unless asked for', () => {
  it('keeps mood equal to the fast layer by default', () => {
    const base = createPsycheState({}, t0)
    const seeded = { ...base, vad: { valence: 0.1, arousal: 0, dominance: 0 } }
    const after = wait(seeded, 6)
    // With the slow layer off, mood is not a second state: it is the emotion.
    expect(after.mood.valence).toBeCloseTo(after.vad.valence, 12)
  })

  it('does not report two states at the instant of an event', () => {
    const base = createPsycheState({}, t0)
    const after = transitionPsycheState(
      { ...base, vad: { ...base.baseline }, mood: { ...base.baseline } },
      { kind: 'event', delta: { valence: -0.5 }, eventId: 'e-instant' },
      t0,
    )
    // Event application moved `vad`, so `mood` must move with it in the same
    // return value; otherwise a reader sees the new emotion next to the old mood.
    expect(after.mood.valence).toBeCloseTo(after.vad.valence, 12)
    expect(after.mood.arousal).toBeCloseTo(after.vad.arousal, 12)
    expect(after.mood.dominance).toBeCloseTo(after.vad.dominance, 12)
  })

  it('still honours the explicit fitted constants', () => {
    enableSlowLayer()
    const base = createPsycheState({}, t0)
    const seeded = { ...base, vad: { valence: 0.1, arousal: 0, dominance: 0 } }
    const after = wait(seeded, 6)
    expect(after.mood.valence).not.toBeCloseTo(after.vad.valence, 6)
  })
})

describe('decay is independent of read frequency', () => {
  it('lands on the same state for one sparse read and many dense reads', () => {
    const base = createPsycheState({}, t0)
    const seeded = {
      ...base,
      vad: { valence: 0.018, arousal: -0.2, dominance: -0.27 },
      mood: { valence: -0.2, arousal: 0.1, dominance: 0.2 },
    }

    const sparse = transitionPsycheState(seeded, { kind: 'no_event' }, t0 + 24 * HOUR)

    let dense = seeded
    for (let i = 0; i < 288; i++)
      dense = transitionPsycheState(dense, { kind: 'no_event' }, t0 + (i + 1) * 5 * 60_000)

    // getPsycheState advances the state on every read, so a panel polling every
    // five minutes used to land somewhere else than a single read after a day.
    expect(dense.vad.valence).toBeCloseTo(sparse.vad.valence, 8)
    expect(dense.vad.arousal).toBeCloseTo(sparse.vad.arousal, 8)
    expect(dense.vad.dominance).toBeCloseTo(sparse.vad.dominance, 8)
    expect(dense.mood.valence).toBeCloseTo(sparse.mood.valence, 8)
  })
})

describe('a trajectory that crosses the baseline', () => {
  beforeEach(enableSlowLayer)

  const seeded = (vadValence: number, moodValence: number, bias: number) => {
    const base = createPsycheState({}, t0)
    return {
      ...base,
      vad: { valence: vadValence, arousal: 0, dominance: 0 },
      mood: { valence: moodValence, arousal: 0, dominance: 0 },
      valenceBias: bias,
    }
  }

  for (const [label, vad, mood] of [
    ['falling through it', 0.45, -0.2],
    ['rising through it', -0.1, 0.45],
  ] as const) {
    it(`lands in the same place for one and many reads (${label})`, () => {
      // `PsycheState` 的 valenceBias 是可选的（老状态没有这个字段），而 seeded() 返回的是
      // 字面量类型；不标注的话 `many = transitionPsycheState(...)` 会因为缺字段报 TS2322。
      const start: PsycheState = seeded(vad, mood, 1.6)
      const one = transitionPsycheState(start, { kind: 'no_event' }, t0 + 24 * HOUR)
      let many = start
      for (let i = 0; i < 288; i++)
        many = transitionPsycheState(many, { kind: 'no_event' }, t0 + (i + 1) * 5 * 60_000)

      // The multiplier is frozen per event, so the coefficient does not change
      // mid-step and a single long read is the same function as many short ones.
      expect(one.vad.valence < 0.4).not.toBe(vad < 0.4)
      expect(many.vad.valence).toBeCloseTo(one.vad.valence, 12)
      expect(many.mood.valence).toBeCloseTo(one.mood.valence, 12)
    })
  }

  it('freezes the bias on the event that set it', () => {
    const base = createPsycheState({}, t0)
    const negative = transitionPsycheState(
      { ...base, vad: { ...base.baseline }, mood: { ...base.baseline } },
      { kind: 'event', delta: { valence: -0.5 }, eventId: 'e1' },
      t0,
    )
    expect(negative.vad.valence).toBeLessThan(negative.baseline.valence)
    expect(negative.valenceBias).toBeGreaterThan(1)
  })
})
