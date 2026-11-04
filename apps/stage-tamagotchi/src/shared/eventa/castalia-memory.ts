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
/** 一次召回：`persona` 是发问那张卡的 id，缺省时后端用配置里的角色。 */
export interface CastaliaMemoryRecallInput {
  query: string
  persona?: string
}
export const castaliaMemoryRecall = defineInvokeEventa<CastaliaRecalledMemory, CastaliaMemoryRecallInput>('eventa:invoke:castalia:memory:recall')

/**
 * One ranked hit of an explicit lookup (the model's search tool, not the injection block).
 *
 * `score` is the engine's relevance; an empty list means nothing matched.
 */
export interface CastaliaSearchedMemory {
  id?: string
  text: string
  score: number
  memType?: string
  category?: string
  createdAt?: string
}

export interface CastaliaMemorySearchInput {
  query: string
  topK?: number
  /** 发起检索的那张卡；缺省时后端用配置里的角色（两段式调用会因此读到别人的分区）。 */
  persona?: string
}

export const castaliaMemorySearch = defineInvokeEventa<CastaliaSearchedMemory[], CastaliaMemorySearchInput>('eventa:invoke:castalia:memory:search')

/**
 * One structured fact (subject · predicate · object) found by the same lookup.
 *
 * Facts are the one-line answers the memory rows only imply, so the search tool prints them
 * beside the rows instead of asking the model for a second call.
 */
export interface CastaliaSearchedFact {
  subject: string
  predicate: string
  object: string
  confidence: number
  similarity?: number
}

export const castaliaMemoryFacts = defineInvokeEventa<CastaliaSearchedFact[], CastaliaMemorySearchInput>('eventa:invoke:castalia:memory:facts')

/** 一轮对话的写回（自回归结束后调用）。失败不抛错，返回 {ok:false}。 */
export interface CastaliaIngestTurnInput {
  user: string
  assistant: string
  sessionId?: string
  /** 这一轮对话属于哪张卡；缺省时后端用配置里的角色。 */
  persona?: string
}
export interface CastaliaIngestTurnResult {
  ok: boolean
  id?: string
  mode?: string
  error?: string
}
export const castaliaMemoryIngest = defineInvokeEventa<CastaliaIngestTurnResult, CastaliaIngestTurnInput>('eventa:invoke:castalia:memory:ingest')

export interface CastaliaSelfCycleReport {
  ok: boolean
  skipped: boolean
  reason?: string
  diaryId?: string
  /** 这一轮写下的日记正文（从 diaryId 取回），供「无聊时思考」把它当一条内部念头读出来。 */
  diaryText?: string
  evidenceIds: string[]
  project: string
}

export const castaliaMemorySelfCycle = defineInvokeEventa<CastaliaSelfCycleReport, { limit?: number, hoursBack?: number, minIntervalHours?: number, energy?: number, characterId?: string } | undefined>('eventa:invoke:castalia:memory:self-cycle')

/**
 * 引擎当前的 psyche（情绪坐标 + 慢层心境 + band）。
 *
 * 引擎是这份状态的唯一真源：UI 只读它来镜像自己的 self-state，不自己累积情绪。
 */
export interface CastaliaPsycheSnapshot {
  characterId: string
  project: string
  hasEvidence: boolean
  band: string
  vad: { valence: number, arousal: number, dominance: number }
  mood: { valence: number, arousal: number, dominance: number }
  version: number
  updatedAt: number
}
export const castaliaMemorySetEnergy = defineInvokeEventa<{ ok: boolean }, { value: number, persona?: string }>('eventa:invoke:castalia:memory:set-energy')
export const castaliaMemoryPsyche = defineInvokeEventa<CastaliaPsycheSnapshot | null, { characterId?: string } | undefined>('eventa:invoke:castalia:memory:psyche')

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
  /** The request hit the shared cooldown; the stages below are the last run. */
  skipped?: boolean
  skippedReason?: string
}
export const castaliaMemoryMaintain = defineInvokeEventa<CastaliaMaintainReport, { limit?: number } | undefined>('eventa:invoke:castalia:memory:maintain')

/**
 * What the memory module is actually wired to right now.
 *
 * The switch in Settings says the module is on; this says whether the running backend can recall,
 * search, ingest or run the loop. Without it "已配置" was read as "可用" (audit F05).
 */
export interface CastaliaMemoryCapabilities {
  /** 后端能否处理超龄的 VAD 队列批次（stdio 后端没有这个工具）。 */
  vadSweep: boolean
  recall: boolean
  search: boolean
  facts: boolean
  ingest: boolean
  maintain: boolean
  selfCycle: boolean
  psyche: boolean
}

/** 自动情感那套实验门槛的实际状态：开关开着不等于它就在推动 psyche。 */
export interface CastaliaEmotionGate {
  /** PSYCHE_FROM_VAD 是否开启。关了就只有工具写入能改 psyche。 */
  autoFromVad: boolean
  /** 后端有没有显式写入通道：模型判断出的情绪能不能落到引擎 psyche。 */
  explicit: boolean
  /** 谁在分析：模型端点，还是本地词表（词表会主动放弃判断，不产生证据）。 */
  estimator: 'model' | 'lexicon'
  /** 一句人话，直接显示在面板上。 */
  note: string
}

export interface CastaliaMemoryStatus {
  transport: 'in-process' | 'stdio' | 'entry-only' | 'none'
  project?: string
  character?: string
  engineEntry?: string
  capabilities: CastaliaMemoryCapabilities
  emotion?: CastaliaEmotionGate
  /** 上一次读取的条目规模，`truncated` 表示面板与索引只看到一部分。 */
  entries?: { listed: number, truncated: boolean }
  /** One sentence for the panel: which check failed, or what this backend cannot do. */
  error?: string
  checkedAt: number
}

export const castaliaMemoryStatus = defineInvokeEventa<CastaliaMemoryStatus>('eventa:invoke:castalia:memory:status')

/** 模型判断出的一条情绪：三个维度，加上它为什么这样判断。 */
export interface CastaliaEmotionInput {
  vad: { valence: number, arousal: number, dominance: number }
  reason?: string
  /** 证据时间。同一轮的重试必须给同一个值，否则一次情绪会被记成两次。 */
  at?: number
  eventId?: string
  /** 这张卡：情绪写到它自己的库里，不落到配置的默认角色上。 */
  persona?: string
}

/** `applied` 表示 psyche 版本真的前进了。 */
export interface CastaliaEmotionResult {
  applied: boolean
  reason: 'applied' | 'neutral' | 'invalid' | 'unknown' | 'unsupported' | 'closing' | 'disabled' | 'persist_failed'
  version: number
}

/**
 * 把模型判断出的情绪写进引擎 psyche。
 *
 * 与 PSYCHE_FROM_VAD 那条自动估计器链分开：模型带理由的显式判断属于工具写入，
 * 那条链关着时它仍然生效。
 */
export const castaliaMemoryApplyEmotion = defineInvokeEventa<CastaliaEmotionResult, CastaliaEmotionInput>('eventa:invoke:castalia:memory:apply-emotion')

/**
 * 把面板上的模块开关推给主进程。
 *
 * 渲染层的 guard 只挡得住工具和提示词；VAD 扫描、夜间维护、自循环是主进程自己排的定时器，
 * 它们不知道面板上那个开关（审计 A06）。开关关闭时，这些 tick 什么都不做。
 */
export const castaliaMemorySetEnabled = defineInvokeEventa<{ ok: boolean }, { memory: boolean, castalia: boolean }>('eventa:invoke:castalia:memory:set-enabled')


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
