// 引擎侧「能力清单」的类型（引擎仓根的 tuning-support.json）。
//
// 为什么需要它：同一个面板要接三种引擎变体 ——
//   心智版（完整 Anima）  30 项：情绪状态机 6 组 + 2 个衰减开关 + 检索/注入
//   记忆+面板版            7 项：4 个检索权重 + 3 个注入门槛（没有情绪状态机）
//   标准版带面板           3 项：相关性/时间权重 + 检索下限（没有情感侧的量）
// 面板如果照自己那份静态清单画，接标准版时会画出 6 组转了没反应的旋钮。
// 所以「支持哪些键、默认值多少」由引擎自己声明，面板只画清单里的。
//
// 生成方式：packages/castalia-plugin/scripts/sync-engine.mjs 读引擎仓根的
// tuning-support.json，写成 src/vendor/engine/tuningSupport.ts；
// 引擎没带清单（心智版）→ TUNING_SUPPORT = null → 面板退回完整静态清单，行为不变。

export interface EngineTuningSpec {
  key: string
  kind: 'number' | 'bool'
  default: number
  min: number
  max: number
  step: number
  /** 模块级常量：改完必须重启后端 */
  restart?: boolean
  label: { zh: string, en: string }
  hint?: { zh: string, en: string }
}

export interface EngineTuningManifest {
  spec_version: number
  engine: string
  variant: string
  engine_version?: string
  groups: Record<string, EngineTuningSpec[]>
  presets?: Record<string, {
    label: { zh: string, en: string }
    note?: { zh: string, en: string }
    values: Record<string, string>
  }>
}
