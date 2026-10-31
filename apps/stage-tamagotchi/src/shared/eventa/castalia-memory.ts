import type { CastaliaMemoryEntry } from '@proj-airi/castalia-plugin/memory'

import { defineInvokeEventa } from '@moeru/eventa'

/**
 * One recall for the injection block.
 *
 * Empty `text` means the backend found nothing that passed its similarity gate,
 * so the caller appends the block without a relevance check of its own.
 */
export interface CastaliaRecalledMemory {
  text: string
  /** Items inside the block. */
  count: number
  /** Highest cosine similarity of the recall. */
  topSim: number
  /** Length of the block, in characters. */
  chars: number
}

export const castaliaMemoryList = defineInvokeEventa<CastaliaMemoryEntry[]>('eventa:invoke:castalia:memory:list')
export const castaliaMemorySave = defineInvokeEventa<void, CastaliaMemoryEntry>('eventa:invoke:castalia:memory:save')
/** 删除一条记忆：有 `id` 按行删（castalia 库），否则按 `name` + `persona` 找 store 条目。 */
export interface CastaliaMemoryForgetInput {
  id?: string
  name?: string
  persona?: string
}
export const castaliaMemoryForget = defineInvokeEventa<boolean, CastaliaMemoryForgetInput>('eventa:invoke:castalia:memory:forget')
export const castaliaMemoryRecall = defineInvokeEventa<CastaliaRecalledMemory, string>('eventa:invoke:castalia:memory:recall')

/** 一轮对话的写回（自回归结束后调用）。失败不抛错，返回 {ok:false}。 */
export interface CastaliaIngestTurnInput {
  user: string
  assistant: string
  sessionId?: string
}
export interface CastaliaIngestTurnResult {
  ok: boolean
  id?: string
  mode?: string
  error?: string
}
export const castaliaMemoryIngest = defineInvokeEventa<CastaliaIngestTurnResult, CastaliaIngestTurnInput>('eventa:invoke:castalia:memory:ingest')

/** 记忆维护（抽取 + 整合 + digest），全部在主进程内跑；失败不抛错，报告里带 error。 */
export interface CastaliaMaintainReport {
  ok: boolean
  startedAt: string
  ms: number
  reflectConfigured: boolean
  reflect?: Record<string, unknown>
  consolidate?: Record<string, unknown>
  digest?: Record<string, unknown>
  before?: Record<string, number>
  after?: Record<string, number>
  error?: string
}
export const castaliaMemoryMaintain = defineInvokeEventa<CastaliaMaintainReport, { limit?: number } | undefined>('eventa:invoke:castalia:memory:maintain')

/**
 * 心智 / 检索参数（2026-10-31）。
 *
 * 清单与取值范围在 `@proj-airi/castalia-plugin/tuning`（引擎侧唯一一份）；
 * 这里是「读快照 / 存一组值」两个动作。存完 psyche 那批参数立刻生效，
 * 检索权重（模块级常量）要重启 app，`needsRestart` 会说明。
 */
export interface CastaliaTuningSnapshot {
  file: string
  values: Record<string, string>
  effective: Record<string, string>
  rejected: { key: string, reason: string }[]
  needsRestart: boolean
}

export const castaliaTuningGet = defineInvokeEventa<CastaliaTuningSnapshot>('eventa:invoke:castalia:tuning:get')
export const castaliaTuningSave = defineInvokeEventa<
  CastaliaTuningSnapshot,
  { values: Record<string, string | number | boolean | null> }
>('eventa:invoke:castalia:tuning:save')

// ── Full 总线（fedServer 3314）───────────────────────────────────────────────
// 记忆体本体走进程内插件；这里只保留"跨库"那一层：总线能一次查所有库，
// 面板「记忆体」页用它浏览，长期记忆页仍然只看 castalia 本库。

export interface CastaliaFullMember {
  id: string
  label?: string
  variant?: string
  transport?: string
  target?: string
  ok?: boolean
  memories?: number
  libraries?: number
}

export interface CastaliaFullHit {
  instance: string
  project?: string
  score: number
  text: string
  memType?: string
}

export interface CastaliaFullMembersResult {
  ok: boolean
  totalMemories: number
  members: CastaliaFullMember[]
  error?: string
}

export interface CastaliaFullSearchResult {
  ok: boolean
  count: number
  results: CastaliaFullHit[]
  error?: string
}

/** 总线成员表：每个库的路径、条数、是否可读。 */
export const castaliaFullMembers = defineInvokeEventa<CastaliaFullMembersResult>('eventa:invoke:castalia:full:members')

/** 跨库检索：一次查所有成员（或指定成员）。 */
export const castaliaFullSearch = defineInvokeEventa<CastaliaFullSearchResult, { query: string, topK?: number, members?: string[] }>('eventa:invoke:castalia:full:search')

/** 打开 Castalia 控制台的某一栏（agg=记忆总成 / mng=库管理 / viz=星图）。 */
export interface CastaliaOpenConsoleInput {
  view?: 'agg' | 'mng' | 'viz'
  url?: string
}
export interface CastaliaOpenConsoleResult {
  ok: boolean
  via: 'shell' | 'browser'
  error?: string
}
export const castaliaOpenConsole = defineInvokeEventa<CastaliaOpenConsoleResult, CastaliaOpenConsoleInput>('eventa:invoke:castalia:console:open')
