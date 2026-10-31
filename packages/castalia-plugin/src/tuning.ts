import type { EngineTuningManifest, EngineTuningSpec } from './engineTuning'
/**
 * 心智/检索参数的唯一清单（2026-10-31）。
 *
 * 为什么这份清单放在插件里而不是 app：这些键是**引擎的 env 契约**，取值范围也只有引擎
 * 那边知道（默认值来自 `readPsycheTuning()` 与 `search.ts` 的模块常量）。app 只做三件事：
 * 把值写进 `castalia-engine.json` 的 `tuning`、在引擎加载前注入 `process.env`、把清单画成表单。
 *
 * 两条硬规矩：
 *   1) **白名单**。只有这里列出的 key 会被注入 —— 菜单永远不能改 PATH/NODE_OPTIONS 之类的东西。
 *   2) **越界即拒绝**，不静默夹到边界。写错一个 10 倍的值（比如把半衰期当成分钟填）应该被
 *      挡下来并告诉用户，而不是悄悄改成 max。
 */
import type { PsycheTuning } from './vendor/engine/psycheState'

import { TUNING_SUPPORT } from './vendor/engine/tuningSupport'

export type TuningGroup = 'band' | 'halfLife' | 'mood' | 'gain' | 'trait' | 'evidence' | 'search' | 'inject'

export interface TuningSpec {
  /** env 名 —— 引擎读的就是它 */
  key: string
  group: TuningGroup
  /** `number` 直接填；`bool` 用 0/1 */
  kind: 'number' | 'bool'
  /** 引擎的默认值（与 src 保持一致；改了引擎默认要同时改这里） */
  default: number
  min: number
  max: number
  step: number
  /** 模块级常量：改了必须重启后端才生效（其余每轮读取，改完立刻生效） */
  restart?: boolean
  /** 参数名跟着引擎走，不另存一份 i18n（参数名变了就是引擎契约变了） */
  label: { zh: string, en: string }
  hint?: { zh: string, en: string }
}

export const TUNING_SPECS: readonly TuningSpec[] = [
  // ── band：情绪标签落在哪一档 ───────────────────────────────────────────
  {
    key: 'PSYCHE_BAND_CENTER_OFFSET',
    group: 'band',
    kind: 'number',
    default: 0,
    min: -0.6,
    max: 0.6,
    step: 0.01,
    label: { zh: 'band 中心偏置', en: 'Band center offset' },
    hint: {
      zh: '相对人格基线的偏置。负值让「偏正向」更容易出现（−0.35 ≈ 以 0.05 为中心）；0 = 中心就是人格基线',
      en: 'Offset from the personality baseline. Negative makes “positive” easier (−0.35 ≈ centred at 0.05); 0 = centred on the baseline',
    },
  },
  {
    key: 'PSYCHE_BAND_ENTER',
    group: 'band',
    kind: 'number',
    default: 0.25,
    min: 0.02,
    max: 0.8,
    step: 0.01,
    label: { zh: '进入阈值', en: 'Enter threshold' },
    hint: {
      zh: '偏离超过它才换标签。越小越敏感',
      en: 'Deviation needed to switch label. Smaller = more sensitive',
    },
  },
  {
    key: 'PSYCHE_BAND_HOLD',
    group: 'band',
    kind: 'number',
    default: 0.1,
    min: 0.01,
    max: 0.4,
    step: 0.01,
    label: { zh: '保持阈值', en: 'Hold threshold' },
    hint: { zh: '滞回：已在某一档时，掉到它以下才回中性。必须小于进入阈值', en: 'Hysteresis: stays in the band until it drops below this. Must be < enter' },
  },

  // ── 快层半衰期（小时，参数语义是 H 不是 τ）────────────────────────────
  {
    key: 'PSYCHE_HALF_LIFE_VALENCE_HOURS',
    group: 'halfLife',
    kind: 'number',
    default: 1.97,
    min: 0.25,
    max: 48,
    step: 0.01,
    label: { zh: '情绪半衰期 · 效价 (h)', en: 'Mood half-life · valence (h)' },
    hint: { zh: '情绪往心境回落的速度。1.97h = E2 的 τ 2.85h × ln2', en: 'How fast emotion settles into mood. 1.97h = E2 τ 2.85h × ln2' },
  },
  {
    key: 'PSYCHE_HALF_LIFE_AROUSAL_HOURS',
    group: 'halfLife',
    kind: 'number',
    default: 4,
    min: 0.25,
    max: 48,
    step: 0.1,
    label: { zh: '情绪半衰期 · 唤醒 (h)', en: 'Mood half-life · arousal (h)' },
  },
  {
    key: 'PSYCHE_HALF_LIFE_DOMINANCE_HOURS',
    group: 'halfLife',
    kind: 'number',
    default: 36,
    min: 1,
    max: 168,
    step: 1,
    label: { zh: '情绪半衰期 · 支配 (h)', en: 'Mood half-life · dominance (h)' },
  },

  // ── 慢层心境（多少个 0 = 关掉整层）──────────────────────────────────────
  {
    key: 'PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS',
    group: 'mood',
    kind: 'number',
    default: 45.75,
    min: 0,
    max: 240,
    step: 0.25,
    label: { zh: '心境半衰期 · 效价 (h)', en: 'Mood layer half-life · valence (h)' },
    hint: { zh: '整天心情偏低就是它。0 = 关闭慢层，退回单层', en: 'What keeps a bad day lasting. 0 = disable the slow layer' },
  },
  {
    key: 'PSYCHE_MOOD_HALF_LIFE_AROUSAL_HOURS',
    group: 'mood',
    kind: 'number',
    default: 16,
    min: 0,
    max: 240,
    step: 0.5,
    label: { zh: '心境半衰期 · 唤醒 (h)', en: 'Mood layer half-life · arousal (h)' },
  },
  {
    key: 'PSYCHE_MOOD_HALF_LIFE_DOMINANCE_HOURS',
    group: 'mood',
    kind: 'number',
    default: 144,
    min: 0,
    max: 480,
    step: 1,
    label: { zh: '心境半衰期 · 支配 (h)', en: 'Mood layer half-life · dominance (h)' },
  },
  {
    key: 'PSYCHE_MOOD_RELAX_RATIO',
    group: 'mood',
    kind: 'number',
    default: 1,
    min: 0.1,
    max: 4,
    step: 0.05,
    label: { zh: '心境回落倍率', en: 'Mood relax ratio' },
    hint: { zh: '调大 = 坏心情持续更久', en: 'Larger = a bad mood lingers longer' },
  },

  // ── 增益与单步限幅 ────────────────────────────────────────────────────
  {
    key: 'PSYCHE_TARGET_GAIN',
    group: 'gain',
    kind: 'number',
    default: 0.55,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '目标观测增益', en: 'Target gain' },
    hint: { zh: '传感器给的是「当前状态」时的跟随速度', en: 'Follow speed when the sensor reports an absolute state' },
  },
  {
    key: 'PSYCHE_EVENT_GAIN',
    group: 'gain',
    kind: 'number',
    default: 0.35,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '事件增量增益', en: 'Event gain' },
  },
  {
    key: 'PSYCHE_MAX_STEP',
    group: 'gain',
    kind: 'number',
    default: 0.35,
    min: 0.05,
    max: 1,
    step: 0.01,
    label: { zh: '单步最大位移', en: 'Max step' },
    hint: { zh: '一件事最多把状态推这么远。注意它同时遮住了饱和项', en: 'How far one event can push the state. Also masks the saturation term' },
  },

  // ── 「像人」的四条性质（不是标定常数）──────────────────────────────────
  {
    key: 'PSYCHE_NEGATIVE_IMPACT',
    group: 'trait',
    kind: 'number',
    default: 1.35,
    min: 1,
    max: 3,
    step: 0.01,
    label: { zh: '负性偏向（冲击）', en: 'Negativity bias (impact)' },
  },
  {
    key: 'PSYCHE_NEGATIVE_PERSISTENCE',
    group: 'trait',
    kind: 'number',
    default: 1.6,
    min: 1,
    max: 4,
    step: 0.05,
    label: { zh: '负性偏向（持续时间）', en: 'Negativity bias (duration)' },
  },
  {
    key: 'PSYCHE_INERTIA',
    group: 'trait',
    kind: 'number',
    default: 0.55,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '惯性（反向折扣）', en: 'Inertia (reverse discount)' },
  },
  {
    key: 'PSYCHE_SATURATION',
    group: 'trait',
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '饱和强度', en: 'Saturation' },
  },
  {
    key: 'PSYCHE_SALIENCE_PERSISTENCE',
    group: 'trait',
    kind: 'number',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
    label: { zh: '重要性放大', en: 'Salience amplification' },
    hint: { zh: '重要的事偏离持续更久', en: 'Important events keep the deviation longer' },
  },

  // ── 证据有效期 ────────────────────────────────────────────────────────
  {
    key: 'PSYCHE_EVIDENCE_TTL_HOURS',
    group: 'evidence',
    kind: 'number',
    default: 72,
    min: 6,
    max: 720,
    step: 1,
    label: { zh: '证据有效期 (h)', en: 'Evidence TTL (h)' },
    hint: { zh: '超过就交回中性，不再当作「当前状态」', en: 'After this the state is no longer treated as current' },
  },
  {
    key: 'PSYCHE_EVENT_RETENTION_DAYS',
    group: 'evidence',
    kind: 'number',
    default: 90,
    min: 1,
    max: 3650,
    step: 1,
    label: { zh: 'psyche_events 保留天数', en: 'psyche_events retention (days)' },
  },
  {
    key: 'ANIMA_NIGHT_DECAY',
    group: 'evidence',
    kind: 'bool',
    default: 0,
    min: 0,
    max: 1,
    step: 1,
    restart: true,
    label: { zh: '夜间衰减倍率', en: 'Night decay multiplier' },
    hint: { zh: '默认关。打开后入夜会重算同一段过去的情绪', en: 'Off by default: it re-interprets the same past at night' },
  },
  {
    key: 'ANIMA_TSUNDERE_DECAY',
    group: 'evidence',
    kind: 'bool',
    default: 0,
    min: 0,
    max: 1,
    step: 1,
    restart: true,
    label: { zh: '傲娇减速', en: 'Tsundere slowdown' },
    hint: { zh: '默认关：人格表达不该等于遗忘速度', en: 'Off by default: persona should not set the forgetting rate' },
  },

  // ── 检索权重（模块级常量 → 需重启后端）──────────────────────────────────
  {
    key: 'WEIGHT_CONSISTENCY',
    group: 'search',
    kind: 'number',
    default: 1,
    min: 0,
    max: 3,
    step: 0.01,
    restart: true,
    label: { zh: '权重 · 相关性', en: 'Weight · relevance' },
  },
  {
    key: 'WEIGHT_EMOTION',
    group: 'search',
    kind: 'number',
    default: 0.12,
    min: 0,
    max: 2,
    step: 0.01,
    restart: true,
    label: { zh: '权重 · 情感强度', en: 'Weight · emotion' },
    hint: { zh: '0 与 0.12 在 69 条金标上分不出来（R33）', en: '0 and 0.12 are indistinguishable on the 69-query gold set (R33)' },
  },
  {
    key: 'WEIGHT_TIME',
    group: 'search',
    kind: 'number',
    default: 0.03,
    min: 0,
    max: 1,
    step: 0.01,
    restart: true,
    label: { zh: '权重 · 时间衰减', en: 'Weight · recency' },
    hint: { zh: '0.15 → 0.03 时金标命中@1 从 55.1% 到 72.5%（同协议）', en: '0.15 → 0.03 took gold hit@1 from 55.1% to 72.5% (same protocol)' },
  },
  {
    key: 'WEIGHT_DEVIATION',
    group: 'search',
    kind: 'number',
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.01,
    restart: true,
    label: { zh: '权重 · 偏离加成', en: 'Weight · deviation' },
  },

  // ── 注入门槛（每轮读取 → 即时生效）──────────────────────────────────────
  {
    key: 'MEMORY_INJECT_MIN_SIM_LEXICAL',
    group: 'inject',
    kind: 'number',
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '注入门槛 · 词法', en: 'Inject threshold · lexical' },
    hint: { zh: '抬到 0.35 会让纯词法部署召回掉到 0（2026-10-28 那个 bug）', en: 'Raising to 0.35 zeroes recall on lexical-only deployments (the 2026-10-28 bug)' },
  },
  {
    key: 'MEMORY_INJECT_MIN_SIM',
    group: 'inject',
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '注入门槛 · 相似度', en: 'Inject threshold · similarity' },
  },
  {
    key: 'MEMORY_INJECT_STRONG',
    group: 'inject',
    kind: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.01,
    label: { zh: '证据门 · 至少一条强命中', en: 'Evidence gate · one strong hit' },
  },
]

export const TUNING_GROUPS: readonly TuningGroup[] = ['band', 'halfLife', 'mood', 'gain', 'trait', 'evidence', 'search', 'inject']

/** 预设：只写与默认不同的键。`default` 是空对象 = 全部走代码默认。 */
export const TUNING_PRESETS: Record<string, { label: { zh: string, en: string }, note?: { zh: string, en: string }, values: Record<string, string> }> = {
  default: {
    label: { zh: '默认（中性为主）', en: 'Default (mostly neutral)' },
    note: {
      zh: '中心=人格基线、宽 ±0.25。状态贴着基线时标签就是中性；CPED 那类「状态回不到基线」的语料会几乎不出偏正向',
      en: 'Centred on the baseline, ±0.25. A state hugging the baseline reads neutral; corpora whose state never reaches the baseline almost never read positive',
    },
    values: {},
  },
  positive: {
    label: { zh: '偏正向（CPED 标定）', en: 'Positive-leaning (CPED calibration)' },
    note: {
      zh: '中心 −0.35、宽 ±0.12 —— R16 在 3,749 段 CPED 对话上扫出来的；代价是「状态贴着基线 0.40」的库会把大多数轮次判成偏正向',
      en: 'Centre −0.35, ±0.12 from the R16 sweep on 3,749 CPED dialogues; on a library whose state sits at the 0.40 baseline most turns read positive',
    },
    values: {
      PSYCHE_BAND_CENTER_OFFSET: '-0.35',
      PSYCHE_BAND_ENTER: '0.12',
      PSYCHE_BAND_HOLD: '0.05',
    },
  },
  positive_soft: {
    label: { zh: '偏正向（温和）', en: 'Positive-leaning (mild)' },
    note: {
      zh: '上面两组的中间档：中心 −0.2、宽 ±0.18。想「多一点偏正向」但不想每轮都是它时用',
      en: 'Between the two: centre −0.2, ±0.18. Use when you want a few more positive turns, not all of them',
    },
    values: {
      PSYCHE_BAND_CENTER_OFFSET: '-0.2',
      PSYCHE_BAND_ENTER: '0.18',
      PSYCHE_BAND_HOLD: '0.08',
    },
  },
}

/**
 * 引擎声明的能力（来自 `tuning-support.json`，由 sync-engine.mjs 生成到 vendor/engine/tuningSupport.ts）。
 *
 * null = 引擎没带清单（心智版完整 Anima），此时行为与以前完全一致：面板画完整的 TUNING_SPECS。
 * 非 null = 只画这个变体真正支持的键，默认值也用引擎的（不同变体同名权重默认值不同）。
 */
export function specsFromManifest(manifest: EngineTuningManifest | null | undefined): readonly TuningSpec[] | null {
  if (!manifest || typeof manifest !== 'object' || !manifest.groups)
    return null
  const out: TuningSpec[] = []
  for (const [group, list] of Object.entries(manifest.groups)) {
    if (!Array.isArray(list))
      continue
    for (const spec of list as EngineTuningSpec[]) {
      if (!spec || typeof spec.key !== 'string')
        continue
      out.push({
        key: spec.key,
        group: group as TuningGroup,
        kind: spec.kind === 'bool' ? 'bool' : 'number',
        default: Number(spec.default),
        min: Number(spec.min),
        max: Number(spec.max),
        step: Number(spec.step) || 0.01,
        ...(spec.restart === true ? { restart: true } : {}),
        label: spec.label ?? { zh: spec.key, en: spec.key },
        ...(spec.hint ? { hint: spec.hint } : {}),
      })
    }
  }
  // 有清单但清单为空 = 这个变体没有任何可调项（单记忆版）：返回空数组，
  // 不能退回完整清单，否则面板会画出一排死开关。
  return out
}

/** 引擎清单里的键集合（null = 没有清单） */
export const ENGINE_TUNING_SPECS = specsFromManifest(TUNING_SUPPORT)

/** 面板实际要画的清单：有引擎清单就用它，否则退回完整静态清单。 */
export const ACTIVE_TUNING_SPECS: readonly TuningSpec[] = ENGINE_TUNING_SPECS ?? TUNING_SPECS

/** 只保留清单里真有键的组（空组不画，避免一排死开关/空标题）。 */
export const ACTIVE_TUNING_GROUPS: readonly TuningGroup[] = TUNING_GROUPS.filter(
  group => ACTIVE_TUNING_SPECS.some(spec => spec.group === group),
)

const ACTIVE_KEYS = new Set(ACTIVE_TUNING_SPECS.map(spec => spec.key))

/** 预设里引用了引擎不支持的键 → 整个预设不显示（例如记忆体没有 band 三项）。 */
export const ACTIVE_TUNING_PRESETS: Record<string, { label: { zh: string, en: string }, note?: { zh: string, en: string }, values: Record<string, string> }>
  = Object.fromEntries(
    Object.entries(TUNING_PRESETS)
      .filter(([, preset]) => preset && Object.keys(preset.values ?? {}).length === 0
        ? true
        : Object.keys(preset.values ?? {}).every(key => ACTIVE_KEYS.has(key))),
  )

const ACTIVE_BY_KEY = new Map(ACTIVE_TUNING_SPECS.map(spec => [spec.key, spec]))

export interface TuningCoerceResult {
  /** 规范化后的值（字符串，与 env 同构）；等于默认值的键会被丢掉 */
  values: Record<string, string>
  rejected: { key: string, reason: string }[]
}

/**
 * 把外部输入（JSON / 表单）规范化成 env 值。
 *
 * - 只认白名单里的 key，其余一律 `unknown-key` 拒绝（菜单不能改 PATH）。
 * - `null` / `''` / `undefined` = 恢复默认（从结果里删掉）。
 * - 越界不夹，直接 `out-of-range` 拒绝，让用户看见自己填错了。
 * - `bool` 接受 0/1/'0'/'1'/true/false。
 */
export function coerceTuning(input: unknown, specs?: readonly TuningSpec[]): TuningCoerceResult {
  const table = specs ? new Map(specs.map(spec => [spec.key, spec])) : ACTIVE_BY_KEY
  const values: Record<string, string> = {}
  const rejected: { key: string, reason: string }[] = []
  if (input === null || input === undefined)
    return { values, rejected }
  if (typeof input !== 'object')
    return { values, rejected: [{ key: '*', reason: 'not-an-object' }] }

  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const spec = table.get(key)
    if (!spec) {
      rejected.push({ key, reason: 'unknown-key' })
      continue
    }
    if (raw === null || raw === undefined || raw === '')
      continue

    const numeric = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw)
    if (!Number.isFinite(numeric)) {
      rejected.push({ key, reason: 'not-a-number' })
      continue
    }
    if (spec.kind === 'bool' && numeric !== 0 && numeric !== 1) {
      rejected.push({ key, reason: 'bool-must-be-0-or-1' })
      continue
    }
    if (numeric < spec.min || numeric > spec.max) {
      rejected.push({ key, reason: `out-of-range(${spec.min}..${spec.max})` })
      continue
    }
    if (numeric === spec.default)
      continue // 与默认相同就不落盘，配置文件保持最小
    values[key] = String(numeric)
  }
  return { values, rejected }
}

/** 把一组值注入 env（只写白名单键）。返回真正写进去的键。 */
export function applyTuning(env: NodeJS.ProcessEnv, values: Record<string, string>, specs?: readonly TuningSpec[]): string[] {
  const table = specs ? new Map(specs.map(spec => [spec.key, spec])) : ACTIVE_BY_KEY
  const applied: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!table.has(key))
      continue
    env[key] = value
    applied.push(key)
  }
  return applied
}

/** 把 env 里的当前值读回来（给表单显示「实际生效值」）。 */
export function readTuningFromEnv(env: NodeJS.ProcessEnv, specs?: readonly TuningSpec[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of (specs ?? ACTIVE_TUNING_SPECS)) {
    const raw = env[spec.key]
    if (raw === undefined || raw === '')
      continue
    out[spec.key] = raw
  }
  return out
}

/** 这组值里有没有需要重启后端才生效的键。 */
export function needsRestart(values: Record<string, string>, specs?: readonly TuningSpec[]): boolean {
  const table = specs ? new Map(specs.map(spec => [spec.key, spec])) : ACTIVE_BY_KEY
  return Object.keys(values).some(key => table.get(key)?.restart === true)
}

/** 与某个预设的差异（用于「当前不是默认」这种提示）。 */
export function diffFromPreset(values: Record<string, string>, preset: string): Record<string, string> {
  const target = TUNING_PRESETS[preset]?.values ?? {}
  const out: Record<string, string> = {}
  for (const key of new Set([...Object.keys(values), ...Object.keys(target)])) {
    if ((values[key] ?? '') !== (target[key] ?? ''))
      out[key] = values[key] ?? ''
  }
  return out
}

/**
 * 引擎默认值（从引擎模块读，避免这份清单与代码漂移）。
 * 只在能加载引擎时用；表单没加载引擎时退回 spec.default。
 */
export function defaultsFromEngine(readPsycheTuning: () => PsycheTuning): Record<string, string> {
  const tuning = readPsycheTuning()
  return {
    PSYCHE_BAND_CENTER_OFFSET: String(tuning.bandCenterOffset),
    PSYCHE_BAND_ENTER: String(tuning.bandEnter),
    PSYCHE_BAND_HOLD: String(tuning.bandHold),
    PSYCHE_HALF_LIFE_VALENCE_HOURS: String(tuning.halfLife.valence),
    PSYCHE_HALF_LIFE_AROUSAL_HOURS: String(tuning.halfLife.arousal),
    PSYCHE_HALF_LIFE_DOMINANCE_HOURS: String(tuning.halfLife.dominance),
    PSYCHE_MOOD_HALF_LIFE_VALENCE_HOURS: String(tuning.moodHalfLife.valence),
    PSYCHE_MOOD_HALF_LIFE_AROUSAL_HOURS: String(tuning.moodHalfLife.arousal),
    PSYCHE_MOOD_HALF_LIFE_DOMINANCE_HOURS: String(tuning.moodHalfLife.dominance),
    PSYCHE_MOOD_RELAX_RATIO: String(tuning.moodRelaxRatio),
    PSYCHE_TARGET_GAIN: String(tuning.targetGain),
    PSYCHE_EVENT_GAIN: String(tuning.eventGain),
    PSYCHE_MAX_STEP: String(tuning.maxStep),
    PSYCHE_NEGATIVE_IMPACT: String(tuning.negativeImpact),
    PSYCHE_NEGATIVE_PERSISTENCE: String(tuning.negativePersistence),
    PSYCHE_INERTIA: String(tuning.inertia),
    PSYCHE_SATURATION: String(tuning.saturation),
    PSYCHE_SALIENCE_PERSISTENCE: String(tuning.saliencePersistence),
    PSYCHE_EVIDENCE_TTL_HOURS: String(tuning.evidenceTtlHours),
  }
}

export function specOf(key: string, specs?: readonly TuningSpec[]): TuningSpec | undefined {
  const table = specs ? new Map(specs.map(spec => [spec.key, spec])) : ACTIVE_BY_KEY
  return table.get(key)
}
