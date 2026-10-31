// 两层（快情绪 + 慢心境）的性质测试。
//
// 参数来源：E2 / R10 —— CoVidAffect 121 人的真实序列上，两层拟合得到
// 快层 τf≈2.85h、慢层 τs≈66h（单层 OU 中位 2.34h）。这里断言的是**结构**
// 是否成立，不是复核那两个数字：
//   1) 冲击只推情绪，不瞬间改心境；
//   2) 情绪几小时内淡出，心境整天还在；
//   3) 心境最后仍回到人格基线（不会永久漂移）；
//   4) 关闭慢层时精确退化回单层（A/B 开关）。
import { afterEach, describe, expect, it } from 'vitest'
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

  it('CPED 那组标定（中心 −0.35、宽 0.12）下同一证据进入 positive', () => {
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
    expect(Math.abs(layered.mood.valence - b)).toBeGreaterThan(0.03)

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
    const expected = Math.pow(0.5, 3 / 1.97)
    expect(ratio).toBeGreaterThan(expected - 0.03)
    expect(ratio).toBeLessThan(expected + 0.03)
  })

  it('慢层可由环境变量覆盖：调短后余温更快消失', () => {
    const b = fresh().baseline.valence
    const slow = wait(shock(fresh(), -0.6), 24)
    process.env.PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS = '2'
    const fast = wait(shock(fresh(), -0.6), 24)
    expect(Math.abs(fast.mood.valence - b)).toBeLessThan(Math.abs(slow.mood.valence - b) / 2)
  })
})
