import { describe, expect, it } from 'vitest'

import {
  ACTIVE_TUNING_GROUPS,
  ACTIVE_TUNING_PRESETS,
  ACTIVE_TUNING_SPECS,
  applyTuning,
  coerceTuning,
  diffFromPreset,
  ENGINE_TUNING_SPECS,
  needsRestart,
  readTuningFromEnv,
  specOf,
  specsFromManifest,
  TUNING_GROUPS,
  TUNING_PRESETS,
  TUNING_SPECS,
} from './tuning'

describe('参数清单本身', () => {
  it('每个 spec 的默认值落在自己的区间里', () => {
    for (const spec of TUNING_SPECS) {
      expect(spec.min, spec.key).toBeLessThanOrEqual(spec.max)
      expect(spec.default, spec.key).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default, spec.key).toBeLessThanOrEqual(spec.max)
    }
  })

  it('key 唯一，且分组都在 TUNING_GROUPS 里', () => {
    const keys = TUNING_SPECS.map(spec => spec.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const spec of TUNING_SPECS) expect(TUNING_GROUPS).toContain(spec.group)
  })

  it('band 的保持阈值必须小于进入阈值（否则滞回没有意义）', () => {
    const enter = specOf('PSYCHE_BAND_ENTER')!
    const hold = specOf('PSYCHE_BAND_HOLD')!
    expect(hold.default).toBeLessThan(enter.default)
  })

  it('「偏正向」预设就是我们量过的那组（−0.35 / 0.12 / 0.05）', () => {
    expect(TUNING_PRESETS.positive.values).toEqual({
      PSYCHE_BAND_CENTER_OFFSET: '-0.35',
      PSYCHE_BAND_ENTER: '0.12',
      PSYCHE_BAND_HOLD: '0.05',
    })
  })

  it('默认预设是空的（= 全部走代码默认），不是把默认值抄一遍', () => {
    expect(TUNING_PRESETS.default.values).toEqual({})
  })
})

describe('coerceTuning 的边界', () => {
  it('只认白名单键 —— 菜单不能顺手改 PATH', () => {
    const { values, rejected } = coerceTuning({ PATH: '/evil', PSYCHE_BAND_ENTER: '0.3' })
    expect(values).toEqual({ PSYCHE_BAND_ENTER: '0.3' })
    expect(rejected).toEqual([{ key: 'PATH', reason: 'unknown-key' }])
  })

  it('越界直接拒绝，不夹到边界', () => {
    const { values, rejected } = coerceTuning({ PSYCHE_HALF_LIFE_VALENCE_HOURS: '999' })
    expect(values).toEqual({})
    expect(rejected[0].key).toBe('PSYCHE_HALF_LIFE_VALENCE_HOURS')
    expect(rejected[0].reason).toMatch(/^out-of-range/)
  })

  it('等于默认值的键不落盘（配置文件保持最小）', () => {
    const { values } = coerceTuning({ PSYCHE_BAND_CENTER_OFFSET: 0, PSYCHE_BAND_ENTER: 0.25 })
    expect(values).toEqual({})
  })

  it('null / 空串 = 恢复默认（从结果里消失）', () => {
    const { values } = coerceTuning({ PSYCHE_BAND_CENTER_OFFSET: null, PSYCHE_BAND_ENTER: '' })
    expect(values).toEqual({})
  })

  it('数字与数字字符串等价，布尔只接受 0/1', () => {
    expect(coerceTuning({ PSYCHE_INERTIA: '0.4' }).values).toEqual({ PSYCHE_INERTIA: '0.4' })
    expect(coerceTuning({ PSYCHE_INERTIA: 0.4 }).values).toEqual({ PSYCHE_INERTIA: '0.4' })
    expect(coerceTuning({ ANIMA_NIGHT_DECAY: true }).values).toEqual({ ANIMA_NIGHT_DECAY: '1' })
    expect(coerceTuning({ ANIMA_NIGHT_DECAY: 2 }).rejected[0].reason).toBe('bool-must-be-0-or-1')
  })

  it('非数字输入被拒绝而不是变成 0', () => {
    const { values, rejected } = coerceTuning({ PSYCHE_TARGET_GAIN: 'abc' })
    expect(values).toEqual({})
    expect(rejected[0].reason).toBe('not-a-number')
  })
})

describe('注入 env', () => {
  it('只写白名单键，并报告写了哪些', () => {
    const env: NodeJS.ProcessEnv = {}
    const applied = applyTuning(env, { PSYCHE_BAND_ENTER: '0.12', PATH: '/evil' })
    expect(applied).toEqual(['PSYCHE_BAND_ENTER'])
    expect(env.PSYCHE_BAND_ENTER).toBe('0.12')
    expect(env.PATH).toBeUndefined()
  })

  it('读回 env 只包含白名单里出现过的键', () => {
    const env = readTuningFromEnv({ PSYCHE_BAND_ENTER: '0.12', SOMETHING_ELSE: 'x' })
    expect(env).toEqual({ PSYCHE_BAND_ENTER: '0.12' })
  })

  it('模块级常量才要求重启，psyche 的每轮读取不要求', () => {
    expect(needsRestart({ WEIGHT_TIME: '0.03' })).toBe(true)
    expect(needsRestart({ PSYCHE_BAND_CENTER_OFFSET: '-0.35' })).toBe(false)
    expect(needsRestart({ MEMORY_INJECT_MIN_SIM_LEXICAL: '0.2' })).toBe(false)
  })

  it('与预设的差异只列不同项', () => {
    const diff = diffFromPreset({ PSYCHE_BAND_CENTER_OFFSET: '-0.2', PSYCHE_BAND_ENTER: '0.12' }, 'positive')
    // 语义：给的是「恢复成该预设要改的键」—— 相同的键不出现，预设里有而当前没有的键给空串。
    expect(Object.keys(diff).sort()).toEqual(['PSYCHE_BAND_CENTER_OFFSET', 'PSYCHE_BAND_HOLD'])
    expect(diff.PSYCHE_BAND_CENTER_OFFSET).toBe('-0.2')
    expect(diff.PSYCHE_BAND_HOLD).toBe('')
    expect(diff.PSYCHE_BAND_ENTER).toBeUndefined()
  })
})

// ── 引擎能力清单（tuning-support.json）──────────────────────────────────────
// 面板只画清单里有的键：心智版 30 项、记忆+面板 7 项、标准版带面板 3 项。
const MEMORY_PANEL_MANIFEST = {
  spec_version: 1,
  engine: 'castalia-anima',
  variant: 'memory-panel',
  engine_version: '2.0.0',
  groups: {
    search: [
      { key: 'WEIGHT_CONSISTENCY', kind: 'number', default: 1, min: 0, max: 3, step: 0.01, restart: true, label: { zh: '相关性', en: 'relevance' } },
      { key: 'WEIGHT_EMOTION', kind: 'number', default: 0.12, min: 0, max: 2, step: 0.01, restart: true, label: { zh: '情感', en: 'emotion' } },
      { key: 'WEIGHT_TIME', kind: 'number', default: 0.03, min: 0, max: 1, step: 0.01, restart: true, label: { zh: '时间', en: 'recency' } },
      { key: 'WEIGHT_DEVIATION', kind: 'number', default: 0.1, min: 0, max: 1, step: 0.01, restart: true, label: { zh: '偏离', en: 'deviation' } },
    ],
    inject: [
      { key: 'MEMORY_INJECT_MIN_SIM_LEXICAL', kind: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: { zh: '词法', en: 'lexical' } },
      { key: 'MEMORY_INJECT_MIN_SIM', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: { zh: '相似度', en: 'similarity' } },
      { key: 'MEMORY_INJECT_STRONG', kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: { zh: '证据门', en: 'evidence' } },
    ],
  },
  presets: {},
} as const

const STANDARD_PANEL_MANIFEST = {
  spec_version: 1,
  engine: 'castalia',
  variant: 'panel',
  groups: {
    search: [
      { key: 'WEIGHT_CONSISTENCY', kind: 'number', default: 0.65, min: 0, max: 3, step: 0.01, restart: true, label: { zh: '相关性', en: 'relevance' } },
      { key: 'WEIGHT_TIME', kind: 'number', default: 0.35, min: 0, max: 1, step: 0.01, restart: true, label: { zh: '时间', en: 'recency' } },
      { key: 'SEARCH_MIN_SCORE', kind: 'number', default: 0.15, min: 0, max: 1, step: 0.01, restart: true, label: { zh: '下限', en: 'floor' } },
    ],
  },
  presets: {},
} as const

describe('引擎能力清单', () => {
  it('单记忆版：清单是空的 → 空数组（不是 null），面板整块不画', () => {
    const specs = specsFromManifest({ spec_version: 1, engine: 'castalia-anima', variant: 'memory-only', groups: {} } as any)
    expect(specs).toEqual([])
    expect(specs!.length).toBe(0)
  })

  it('没有清单（心智版）→ 退回完整静态清单', () => {
    expect(specsFromManifest(null)).toBeNull()
    // 当前 vendor/engine/tuningSupport.ts 生成的是 null，所以 ACTIVE 就是静态那份
    if (ENGINE_TUNING_SPECS === null)
      expect(ACTIVE_TUNING_SPECS).toEqual(TUNING_SPECS)
  })

  it('记忆+面板版：7 项，只有 search/inject 两组', () => {
    const specs = specsFromManifest(MEMORY_PANEL_MANIFEST as any)!
    expect(specs.map(spec => spec.key)).toHaveLength(7)
    expect(new Set(specs.map(spec => spec.group))).toEqual(new Set(['search', 'inject']))
    expect(specs.some(spec => spec.key.startsWith('PSYCHE_'))).toBe(false)
    // 默认值来自引擎，不是面板自己那份
    expect(specs.find(spec => spec.key === 'WEIGHT_CONSISTENCY')!.default).toBe(1)
    expect(specs.find(spec => spec.key === 'WEIGHT_TIME')!.default).toBe(0.03)
  })

  it('标准版带面板：3 项，且同名权重用标准版自己的默认值', () => {
    const specs = specsFromManifest(STANDARD_PANEL_MANIFEST as any)!
    expect(specs.map(spec => spec.key)).toHaveLength(3)
    expect(specs.find(spec => spec.key === 'WEIGHT_CONSISTENCY')!.default).toBe(0.65)
    expect(specs.find(spec => spec.key === 'WEIGHT_TIME')!.default).toBe(0.35)
  })

  it('用引擎清单做白名单：清单外的键（PSYCHE_*）被拒', () => {
    const specs = specsFromManifest(MEMORY_PANEL_MANIFEST as any)!
    const result = coerceTuning({ PSYCHE_BAND_ENTER: 0.3, WEIGHT_TIME: 0.05 }, specs)
    expect(result.values).toEqual({ WEIGHT_TIME: '0.05' })
    expect(result.rejected).toEqual([{ key: 'PSYCHE_BAND_ENTER', reason: 'unknown-key' }])
  })

  it('用引擎清单做白名单：越界仍拒绝（不夹到边界）', () => {
    const specs = specsFromManifest(STANDARD_PANEL_MANIFEST as any)!
    const result = coerceTuning({ WEIGHT_TIME: 9 }, specs)
    expect(result.values).toEqual({})
    expect(result.rejected[0].reason).toContain('out-of-range')
  })

  it('预设只保留清单能覆盖的那些', () => {
    // 当前 TUNING_SUPPORT=null → ACTIVE 预设 = 静态三档（band 预设都在）
    if (ENGINE_TUNING_SPECS === null) {
      expect(Object.keys(ACTIVE_TUNING_PRESETS)).toEqual(Object.keys(TUNING_PRESETS))
      expect(ACTIVE_TUNING_GROUPS).toEqual(TUNING_GROUPS)
    }
  })
})
