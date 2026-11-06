// NOTICE: 进程内记忆体入口（AIRI 插件层）。
// why: 之前 app 通过 stdio/HTTP 客户端连 CastaliaNode 子进程；这里改成在主进程内直接跑引擎
//      的存储/检索代码，用 node:sqlite + sqlite-vec，不再需要子进程或端口。
// 安全约束（踩过坑）: 以写模式打开真实库时**必须**带上该库的 config.json —— 引擎会对比
//      嵌入空间哈希，配置缺失会被判定为"换了嵌入模型"从而清空派生索引（向量/片段）。
//      下面的 openBank 因此强制校验 config，缺失直接抛错，不给静默清库的机会。
// 移除条件: 引擎提供稳定的、无环境变量耦合的工厂 API 后，这层可以退化成薄包装。
import { existsSync } from 'node:fs'
import process from 'node:process'
import { join } from 'node:path'

/**
 * 这台机器上到底有没有可用的嵌入后端。
 *
 * `isEmbedEnabled()` 只回答「模式不是 none」；默认模式是 ollama，全新安装既没有 Ollama 也没有
 * key，于是每次 `saveMemory` 都静默落一条无向量行。日记写完自检时把这条当成「嵌入端点故障」，
 * 就会每小时拒收并重试，永远记不上一天。只有真的配了后端才要求向量；没配就按 FTS 走，
 * 等用户接上嵌入后端，`batchEmbedPending` 会把日记补上。
 */
function embeddingsConfigured(env: { isEmbedEnabled: () => boolean }): boolean {
  if (!env.isEmbedEnabled())
    return false
  const mode = (process.env.EMBED_MODE || 'ollama').toLowerCase().trim()
  if (mode === 'api')
    return Boolean((process.env.EMBEDDING_API_KEY || '').trim())
  if (mode === 'ollama')
    return Boolean((process.env.OLLAMA_URL || '').trim())
  return true
}

interface SelfCycleOptions {
  project?: string
  characterId?: string
  limit?: number
  hoursBack?: number
  minIntervalHours?: number
  now?: Date
}

type SelfCycleResult = {
  ok: boolean
  skipped: boolean
  reason?: string
  diaryId?: string
  evidenceIds: string[]
  project: string
}

export interface OpenBankOptions {
  /** memory-banks 下的实例目录，例如 .../memory-banks/airi */
  bankDir: string
  /** 项目名（= memory-banks/<bank>/<project>/...），例如 airi */
  project: string
  /** 角色 ID，默认 airi */
  charId?: string
  /** 覆盖 config.json 路径，默认 <bankDir>/config.json */
  configPath?: string
  /** 只为测试/一次性库使用：允许无 config（会强制 EMBED_MODE=none） */
  allowNoConfig?: boolean
}

export interface DiaryDayInput {
  /** 本地日，`YYYY-MM-DD`。同一天再记一次是替换，不是追加。 */
  date: string
  /** 一句话，页面和索引里显示的那行。 */
  description: string
  /** 当天的原文摘录。 */
  body: string
  characterId?: string
}

/**
 * 一行念头,写给 `thoughts/memory.sqlite`。
 *
 * 没有向量:`skipEmbed` 是有意的 —— 这不是用来召回的东西,存档而已。
 */
export interface ThoughtInput {
  /** 念头在 IndexedDB 里的 id;同 id 再写一次是替换。 */
  id: string
  /** 写下那一刻(epoch ms)。 */
  at: number
  text: string
  visibility?: 'private' | 'shared'
  topic?: string
  persona?: string
}

export interface StoredThought {
  id: string
  at: number
  text: string
  visibility: string
  topic?: string
}


export interface BankHandle {
  bankDir: string
  project: string
  charId: string
  engineVersion: string
  save: (params: Record<string, unknown>) => Promise<any>
  search: (options: Record<string, unknown>) => Promise<any[]>
  /**
   * Structured facts (subject · predicate · object) nearest to a query.
   *
   * The chat tool merges these into a search result: facts are one-line answers the memory rows
   * only imply ("who is 小托", "what is her name"), so reading them beside the rows beats another
   * tool call.
   */
  facts: (query: string, options?: { topK?: number, minConfidence?: number }) => Promise<any[]>
  recent: (limit?: number) => any[]
  recall: (query: string, options?: Record<string, unknown>) => Promise<any>
  forget: (id: string, reason?: string) => any
  restore: (id: string) => any
  stats: () => Array<{ memType: string, active: number, vec: number, chunk: number }>
  /** 库里所有活跃记忆（全部 memType，带行 id）：长期记忆页展示用 */
  listMemories: (limit?: number) => Array<{ id: string, text: string, characterId?: string, memType?: string, updatedAt?: string }>
  /**
   * 「记住这一天」—— 一天一条，落在独立的 diary 分区。
   *
   * 分区不在 MEM_TYPES 里：目录枚举、跨库召回、反刍、衰减、星图都看不到它。只有 `searchDiary`
   * 和 `listDiaryDays` 读得到，入口是日记页与模型显式翻日记的工具。
   */
  saveDiaryDay: (input: DiaryDayInput) => Promise<{ id: string, name: string, replaced: boolean }>
  searchDiary: (query: string, options?: { topK?: number, characterId?: string }) => Promise<any[]>
  listDiaryDays: (options?: { limit?: number, characterId?: string }) => Array<{ id: string, name: string | null, description: string, body: string, updatedAt?: string }>
  /** 念头存档:按 id 替换,不建向量。 */
  saveThoughts: (rows: ThoughtInput[]) => Promise<{ saved: number }>
  listThoughts: (options?: { limit?: number, characterId?: string }) => StoredThought[]
  /** memory_store_list 的进程内版本（源 = 引擎的 store 工具实现） */
  listStore: (args?: Record<string, unknown>) => { records: any[] }
  saveStore: (args: Record<string, unknown>) => Promise<{ id: string, updated: boolean }>
  forgetStore: (args: Record<string, unknown>) => { deleted: boolean }
  /**
   * 记忆维护:反刍抽取 + 整合合并 + digest,全部在进程内跑(引擎自带 LLM 通道,key 来自 config.json)。
   *
   * 为什么放在 app 里而不是托盘:这条链只有 AIRI 主进程 ↔ castalia-anima 两段,维护必须长在
   * 同一进程、同一份引擎上;托盘那套是另一个运行时,挂过去就是跨进程漂移。
   */
  maintain: (options?: MaintainOptions) => Promise<MaintainReport>
  /** memory_recall 的进程内版本（含注入渲染与门槛） */
  recallQuery: (query: string, args?: Record<string, unknown>) => Promise<any>
  /** 会话对账:把指向"已不存在会话"的记忆软删(is_active=0),防孤儿。默认 dryRun */
  orphanSessions: (args: { aliveSessionIds: string[], dryRun?: boolean }) => Array<{ memType: string, orphans: number, orphaned: number }>
  /** 各会话下有多少条活跃记忆(审计用) */
  sessionInventory: () => Array<{ memType: string, sessions: Array<{ sessionId: string, memories: number, latest: string }> }>
  /**
   * 一轮对话落库 —— 自回归结束后的写回入口。
   * 最小路径只写 conversation_log + 用户观察(纯本地,不调 LLM);
   * MEMORY_AUTO_PROCESS=1 时改走引擎的完整 autoProcess(含 VAD 队列与会话缓冲,那两步要 LLM)。
   */
  ingestTurn: (turn: IngestTurn) => Promise<IngestResult>
  /** 读取 conversation_log + psyche/AgentState，生成隔离的 agent_diary。 */
  selfCycle: (options?: SelfCycleOptions) => Promise<SelfCycleResult>
  /**
   * 当前 psyche 状态（情绪坐标 + 慢层心境 + band）。
   *
   * 引擎是这份状态的唯一真源；UI 侧只读它来展示/镜像自己的 self-state，
   * 不自己累积情绪，避免两套状态各说各话。
   */
  psycheState: (options?: { characterId?: string, project?: string }) => Promise<PsycheSnapshot>
  /**
   * 把模型判断出的情绪写进引擎 psyche。
   *
   * `PSYCHE_FROM_VAD` 关掉的是**自动估计器**那条链（模型端点与词表都没过 κ≥0.4）。模型自己给出
   * 判断、并带上理由的这一条属于「工具写入」，与那条链不是一类证据。没有这个方法时，
   * recordEmotion 只改提示词和面板，引擎的 psyche 一步都不动 —— 面板上那句自相矛盾就是这样来的。
   */
  applyEmotion: (input: ApplyEmotionInput) => Promise<ApplyEmotionResult>
  /**
   * 队列到期检查（审计 F07）。
   *
   * 十分钟是时限，不是「下一次有人说话再说」：最老的一条超过 `maxAgeSec` 就强制处理，
   * 否则一段安静下来的对话永远等不到情感更新。
   */
  flushStaleVadQueue: (maxAgeSec?: number) => Promise<{ updated: number, pending: number }>
  /** Mirrors the mind's energy into the engine so its own prompts stop inventing one. */
  setSelfEnergy: (value: number) => Promise<void>
  close: () => void
}

/** 模型判断出的情绪：三个维度 + 它为什么这样判断。 */
export interface ApplyEmotionInput {
  vad: { valence: number, arousal: number, dominance: number }
  /** 判断的理由，写进调用方的提示词与面板，不进 psyche_events（那张表没有文本列）。 */
  reason?: string
  /** 证据时间。同一轮的重试必须给同一个值，否则一次情绪会被记成两次。 */
  at?: number
  /** 幂等键。省略时由角色、项目与证据时间拼出来。 */
  eventId?: string
  characterId?: string
  project?: string
}

/**
 * `applied` 表示 psyche 版本前进**并且**落到了库里；`persist_failed` 表示算出来了但没写进 SQLite，
 * 重启后会忘记，所以不能算应用成功。
 */
export interface ApplyEmotionResult {
  applied: boolean
  reason: 'applied' | 'neutral' | 'invalid' | 'unknown' | 'persist_failed'
  version: number
}

export interface PsycheSnapshot {
  characterId: string
  project: string
  hasEvidence: boolean
  band: string
  vad: { valence: number, arousal: number, dominance: number }
  mood: { valence: number, arousal: number, dominance: number }
  version: number
  /** `updatedAt` is the last read; this is the last applied appraisal. -1 means never. */
  updatedAt: number
  lastEvidenceAt: number
}

export interface MaintainOptions {
  /** 单次反刍处理的对话上限,默认 30 */
  limit?: number
  /** 跳过整合(只抽取) */
  skipConsolidate?: boolean
  /** 跳过 digest */
  skipDigest?: boolean
  /** 跳过事件摘要（P2：把一天的对话压成"发生了什么"，只摘录不改写） */
  skipEventDigest?: boolean
  /** 事件摘要回看几天，默认 2 */
  eventDigestDays?: number
}

export interface MaintainReport {
  ok: boolean
  startedAt: string
  ms: number
  /** 引擎是否配了反刍通道(没配就只跑 digest,不报错) */
  reflectConfigured: boolean
  reflect?: { ok: boolean, mode?: string, conversationCount?: number, actions?: number, applied?: number, factsInserted?: number, factsUpdated?: number, errors: string[], deferred?: number }
  consolidate?: { ok: boolean, scanned?: number, candidates?: number, merged?: number, deleted?: number, kept?: number, invalidated?: number, errors: string[] }
  /** 事件摘要：每天把对话压成"发生了什么"（逐字摘录 + 来源 rowid，原文不动） */
  eventDigest?: { ok: boolean, conversations?: number, events?: number, inserted?: number, updated?: number, skipped?: number, errors: string[], skippedReason?: string }
  digest?: { success: boolean, cleaned?: number, restored?: number, vadUpdated?: boolean, errors: string[] }
  before?: Record<string, number>
  after?: Record<string, number>
  error?: string
}

/** 一轮对话:自回归结束后交给记忆体的最小单位 */
export interface IngestTurn {
  user: string
  assistant: string
  /** 会话 ID:仅 MEMORY_AUTO_PROCESS=1 时用于引擎的会话缓冲 */
  sessionId?: string
  /**
   * 这一轮模型已经给出情感结论时一起交回。
   *
   * 行落成 analyzed 并带上 VAD，不进 VAD 队列。同一轮只允许一个估计器写 psyche，
   * 否则显式判定和两分钟后的自动扫描会把同一句话算两次。
   */
  affect?: { vad: { valence: number, arousal: number, dominance: number }, reason?: string }
}
export interface IngestResult {
  ok: boolean
  id?: string
  mode: 'minimal' | 'auto'
  details?: string[]
  error?: string
}

/** 记忆分类库(与引擎 memType 目录一致):孤儿对账要逐库跑 */
const MEM_TYPES = ['general', 'user', 'project', 'reference', 'feedback'] as const

let current: BankHandle | null = null

export function currentBank(): BankHandle | null {
  return current
}

/**
 * 在主进程内打开一个记忆体库。
 *
 * 一个进程只绑一个 bank —— 这不是懒，是被引擎的两处一次性初始化决定的：
 *   1) `configLoader` 在 import 时解析 MEMORY_CONFIG 并把 embedding/LLM 参数注入 process.env，
 *      模块缓存之后不会再读第二份 config；
 *   2) `db.ts` 的 `alignEmbedSpace` 每次开库都拿「库内空间指纹」和「当前 env 的 model|dim」比，
 *      不一致就**清空 vec 表与嵌入缓存**。于是"换个 bank 继续用同一个进程"= 用 A 的配置去开 B 的库，
 *      指纹必然对不上 → 把 B 的向量全清掉（EMBED_MODE=none 时改为跳过对齐，索引同样不可用）。
 * 所以跨 bank 直接拒绝，而不是照旧例默默返回一个看起来正常的句柄。
 * 换 bank 的正确做法：一个 bank 一个引擎进程（桥/子进程），或重启宿主。
 * 同一 bank 内换角色、换 project 不受影响：连接缓存自 v1.32 按库文件的**绝对路径**做键
 * （engine `src/db.ts` 的 getInstance/getGlobal），同一 bank 的不同 project/分类各拿各的连接。
 */
export async function openBank(options: OpenBankOptions): Promise<BankHandle> {
  const bankDir = options.bankDir.replace(/\\/g, '/')
  const project = options.project
  const charId = options.charId ?? 'airi'
  /** 同一天的日记 / 同一条念头的写入队列，键为 project + 角色 + 名字。跨窗口并发由它串行化。 */
  const replaceWrites = new Map<string, Promise<unknown>>()
  const configPath = options.configPath ?? join(bankDir, 'config.json')

  if (!existsSync(bankDir)) throw new Error(`[castalia-bank] bank dir 不存在: ${bankDir}`)

  // 跨 bank 热切换会让 alignEmbedSpace 拿旧配置比对新库 → 清空向量索引，必须显式拒绝。
  if (current && (current.bankDir !== bankDir || current.project !== project)) {
    throw new Error(
      `[castalia-bank] 同一进程不能热切换 bank（当前 ${current.bankDir}#${current.project}，`
      + `请求 ${bankDir}#${project}）：引擎的 config.json 只在首次 import 时生效，`
      + `换库后开库对齐会用旧配置的嵌入空间指纹比对新库，导致新库向量索引被清空。`
      + `请为每个 bank 起独立进程，或重启宿主后再打开。`,
    )
  }

  if (existsSync(configPath)) {
    process.env.MEMORY_CONFIG = configPath
  }
  else if (options.allowNoConfig) {
    process.env.MEMORY_CONFIG = ''
    process.env.EMBED_MODE = 'none'
  }
  else {
    // 不设 MEMORY_CONFIG 会让引擎按默认嵌入模型算哈希，与库里已有的不一致 → 清空向量索引
    throw new Error(`[castalia-bank] 缺少 ${configPath}：拒绝在配置缺失时打开真实库（会触发引擎清空向量索引）`)
  }

  process.env.MEMORY_DB_DIR = bankDir
  process.env.CASTALIA_PROJECT = project
  process.env.CHAR_ID = charId

  // 先跑引擎的配置加载器：它把 config.json 里的嵌入模型/API key 注入 process.env。
  // 少了这一步，引擎会按默认嵌入模型算空间哈希 → 判定"换了嵌入模型"→ 清空向量索引（踩过两次）。
  await import('../vendor/engine/configLoader')

  const [store, search, inject, version] = await Promise.all([
    import('../vendor/engine/store'),
    import('../vendor/engine/search'),
    import('../vendor/engine/recallForInjection'),
    import('../vendor/engine/version'),
  ])
  const db = await import('../vendor/engine/db')
  const engineEnv = await import('../vendor/engine/env')
  const orphan = await import('../vendor/engine/orphan')
  // store 工具（memory_store_list/save/forget + memory_recall 的进程内版本）
  const { createStoreTools, loadEngineDeps, parseStoreText } = await import('./store-tools')
  const { DIARY_MEM_TYPE, THOUGHTS_MEM_TYPE } = await import('../vendor/engine/memType')
  const storeTools = createStoreTools(await loadEngineDeps())

  const handle: BankHandle = {
    bankDir,
    project,
    charId,
    engineVersion: (version as any).VERSION ?? 'unknown',
    // VAD 由引擎 store.saveMemory 在写路径补(见 vendor/engine/store.ts),宿主层不重复写一次。
    save: params => store.saveMemory(params as any),
    search: options2 => search.searchMemory(options2 as any),
    facts: (query, options3 = {}) => search.searchFacts(query, { project, characterId: charId, ...options3 }),
    // 签名: getRecentMemories(characterId, limit, hoursBack, project?, memType?)
    recent: (limit = 5) => search.getRecentMemories(charId, limit, 24 * 365, project) as any[],
    recall: (query, o) => inject.recallForInjection(query, o as any),
    // 签名: forgetMemory(id, project?, characterId?) —— 第二参是项目名，不是原因
    forget: id => store.forgetMemory(id, project, charId),
    restore: id => store.restoreMemory(id, project, charId),
    // 不按 source 过滤：长期记忆页要的是"这个库里的全部记忆"，不是 app 自己写的那几条 store 条目
    listMemories: (limit = 500) => storeTools.listStoreEntries({ project, allCharacters: true, limit })
      .records
      // Self-cycle diaries are derived observations, not memories the page or the prompt index
      // should list. An explicit diary view asks for them with its own entry.
      .filter(record => record.source !== 'agent_diary')
      .map(record => ({
        id: record.id,
        text: record.text ?? record.body,
        characterId: record.characterId,
        memType: record.memType,
        updatedAt: record.updatedAt,
      })),
    saveDiaryDay: ({ date, description, body, characterId }) => {
      const persona = (characterId ?? '').trim() || charId
      const name = `diary-${date}`
      const key = `${project}\u0000${persona}\u0000${name}`
      // 同一天的写入必须串行：两个窗口同时记一天时，各自的 SELECT 都看不到对方还没插的行，
      // 于是各插一条活行（2026-11-06 实测 11-01 一天两条）。排队后第二次能看见第一次的结果。
      const run = (replaceWrites.get(key) ?? Promise.resolve()).then(async () => {
        const text = `# ${name}\n\n${description}\n\n${body}`
        const conn = (db as any).DatabaseManager.getInstance(project, DIARY_MEM_TYPE)
        // 同一天重记 = 替换，不追加：旧行连同向量一起软删，避免同一天在库里留下两版。
        const stale = conn.prepare(
          'SELECT id FROM memory WHERE is_active = 1 AND project = ? AND character_id IS ? AND text LIKE ?',
        ).all(project, persona, `# ${name}%`) as Array<{ id: string }>
        const replaced = stale.length > 0
        for (const row of stale) {
          conn.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), row.id)
          // 引擎自己的约定是「删行先删向量」。软删留着向量时，每次重记都多一条高相似死向量，
          // 几十次之后 KNN 的 40 个候选位会先被同一天的旧版本占满，真正的日记反而挤不进去。
          try {
            conn.prepare('DELETE FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').run(row.id)
          }
          catch { /* 无 vec 表 */ }
        }
        const record = await store.saveMemory({
          text,
          project,
          memType: DIARY_MEM_TYPE,
          type: 'episodic',
          category: 'diary',
          subject: 'self',
          source: 'diary_day',
          characterId: persona,
          importance: 0.6,
        } as any)
        // 另一个进程写同一天时的兜底：插入后把同名的其它活行软删，留最新这一条。
        conn.prepare(
          'UPDATE memory SET is_active = 0, updated_at = ? WHERE id <> ? AND is_active = 1 AND project = ? AND character_id IS ? AND text LIKE ?',
        ).run(new Date().toISOString(), record.id, project, persona, `# ${name}%`)
        // 嵌入端点故障时 saveMemory 会静默落一条无向量行：这一天被标成「已记住」，却永远搜不到。
        // 补嵌入的 sweep 只走 5 个 memType 目录，日记不在其中，所以只能在这里发现并拒收，让它下次再记。
        if (embeddingsConfigured(engineEnv)) {
          let missing = false
          try {
            missing = !conn.prepare('SELECT 1 FROM vec_memory WHERE rowid = (SELECT rowid FROM memory WHERE id = ?)').get(record.id)
          }
          catch { /* 旧库没有 vec 表：不判定 */ }
          if (missing) {
            conn.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), record.id)
            throw new Error('diary day stored without an embedding; refusing to mark it remembered')
          }
        }
        return { id: record.id, name, replaced }
      })
      const tail = run.catch(() => {})
      replaceWrites.set(key, tail)
      void tail.then(() => {
        if (replaceWrites.get(key) === tail)
          replaceWrites.delete(key)
      })
      return run
    },
    searchDiary: async (query, options = {}) => {
      const persona = (options.characterId ?? '').trim() || charId
      return search.searchMemory({
        query,
        project,
        memType: DIARY_MEM_TYPE,
        characterId: persona,
        topK: options.topK ?? 5,
      } as any)
    },
    saveThoughts: async (rows) => {
      let saved = 0
      const now = new Date().toISOString()
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row.id !== 'string' || !row.id || typeof row.text !== 'string' || !row.text.trim())
          continue
        const persona = (row.persona ?? '').trim() || charId
        const name = `thought-${row.id}`
        const key = `${project}\u0000${persona}\u0000${name}`
        // 和日记同一条规则:先排队再替换,否则两个窗口同时补同一段念头会各插一条。
        const run = (replaceWrites.get(key) ?? Promise.resolve()).then(async () => {
          const conn = (db as any).DatabaseManager.getInstance(project, THOUGHTS_MEM_TYPE)
          // 同一条念头再写一次是替换(visibility 会从 private 变 shared),不追加。
          conn.prepare(
            'UPDATE memory SET is_active = 0, updated_at = ? WHERE is_active = 1 AND project = ? AND character_id IS ? AND text LIKE ?',
          ).run(now, project, persona, `# ${name}%`)
          await store.saveMemory({
            text: `# ${name}\n\n${row.text}`,
            project,
            memType: THOUGHTS_MEM_TYPE,
            type: 'episodic',
            category: 'thought',
            subject: 'self',
            source: 'thought_stream',
            characterId: persona,
            importance: 0.2,
            // 存档不是检索:不建向量,也就不占 KNN 候选、不花嵌入费。
            skipEmbed: true,
            metadata: { at: Number(row.at) || Date.now(), visibility: row.visibility ?? 'private', ...(row.topic ? { topic: row.topic } : {}) },
          } as any)
        })
        const tail = run.catch(() => {})
        replaceWrites.set(key, tail)
        void tail.then(() => {
          if (replaceWrites.get(key) === tail)
            replaceWrites.delete(key)
        })
        try {
          await run
          saved++
        }
        catch { /* 单条失败不拖累整批:游标没走过的行下次还会送 */ }
      }
      return { saved }
    },
    listThoughts: (options = {}) => {
      const persona = (options.characterId ?? '').trim() || charId
      const conn = (db as any).DatabaseManager.getInstance(project, THOUGHTS_MEM_TYPE)
      const rows = conn.prepare(
        `SELECT id, text, created_at, metadata FROM memory
         WHERE is_active = 1 AND project = ? AND character_id IS ?
         ORDER BY created_at DESC LIMIT ?`,
      ).all(project, persona, options.limit ?? 6000) as any[]
      return rows.map((row) => {
        const { name, body } = parseStoreText(String(row.text ?? ''))
        let meta: any = {}
        try {
          meta = JSON.parse(String(row.metadata ?? '{}'))
        }
        catch { /* 旧行没有 metadata */ }
        const stamp = String(name ?? '').replace(/^thought-/, '')
        return {
          id: stamp || String(row.id),
          at: Number(meta?.at) || Date.parse(String(row.created_at ?? '')) || 0,
          text: body.trim() || String(row.text ?? ''),
          visibility: typeof meta?.visibility === 'string' ? meta.visibility : 'private',
          ...(typeof meta?.topic === 'string' ? { topic: meta.topic } : {}),
        }
      })
    },
    listDiaryDays: (options = {}) => {
      const persona = (options.characterId ?? '').trim() || charId
      const conn = (db as any).DatabaseManager.getInstance(project, DIARY_MEM_TYPE)
      const rows = conn.prepare(
        `SELECT id, text, created_at, updated_at FROM memory
         WHERE is_active = 1 AND project = ? AND character_id IS ?
         ORDER BY created_at DESC LIMIT ?`,
      ).all(project, persona, options.limit ?? 60) as any[]
      return rows.map(row => ({
        id: String(row.id),
        ...parseStoreText(String(row.text ?? '')),
        updatedAt: row.updated_at ?? row.created_at,
      }))
    },
    listStore: args => storeTools.listStoreEntries({ project, ...args }),
    saveStore: args => storeTools.saveStoreEntry({ project, ...args } as any),
    forgetStore: args => storeTools.forgetStoreEntry({ project, ...args } as any),
    recallQuery: (query, args) => storeTools.recallForQuery(query, { project, ...args }),
    stats: () => {
      const dbMod = db as any
      return ['general', 'user', 'project', 'reference', 'feedback'].map((memType) => {
        const file = join(bankDir, project, memType, 'memory.sqlite')
        if (!existsSync(file)) return { memType, active: 0, vec: 0, chunk: 0 }
        const conn = dbMod.DatabaseManager.getInstance(project, memType)
        const one = (sql: string) => { try { return Number(conn.prepare(sql).get()?.c ?? 0) } catch { return 0 } }
        return {
          memType,
          active: one('SELECT COUNT(*) c FROM memory WHERE is_active=1'),
          vec: one('SELECT COUNT(*) c FROM vec_memory'),
          chunk: one('SELECT COUNT(*) c FROM vec_chunk'),
        }
      })
    },
    orphanSessions: ({ aliveSessionIds, dryRun = true }) => {
      const out: Array<{ memType: string, orphans: number, orphaned: number }> = []
      for (const mt of MEM_TYPES) {
        try {
          const conn = (db as any).DatabaseManager.getInstance(project, mt)
          const r = (orphan as any).orphanMemories(conn, { project, aliveSessionIds, dryRun })
          out.push({ memType: mt, orphans: r.orphans ?? 0, orphaned: r.orphaned ?? 0 })
        }
        catch { /* 该分类库不存在/未建表:跳过 */ }
      }
      return out
    },
    sessionInventory: () => MEM_TYPES.map((mt) => {
      try {
        const conn = (db as any).DatabaseManager.getInstance(project, mt)
        return { memType: mt, sessions: (orphan as any).sessionInventory(conn, 50) }
      }
      catch { return { memType: mt, sessions: [] } }
    }),
    ingestTurn: async (turn) => {
      const user = (turn.user ?? '').trim()
      const assistant = (turn.assistant ?? '').trim()
      // 纯工具调用轮次模型可能不产出正文;写进去只会得到 "用户: x\nairi: " 的残句。
      if (!user || !assistant) return { ok: false, mode: 'minimal', error: 'empty turn' }
      const fullAuto = process.env.MEMORY_AUTO_PROCESS === '1'
      try {
        if (fullAuto) {
          // fullAuto 的落库在引擎的 autoProcess 里，拿不到行 id；显式判定在这条路径上不参与去重。
          // 应用默认走最小路径，这一条只在 MEMORY_AUTO_PROCESS=1 时启用。
          const auto = await import('../vendor/engine/autoProcessor')
          const result = await auto.autoProcess({
            userMessage: user,
            assistantMessage: assistant,
            characterId: charId,
            project,
            sessionId: turn.sessionId,
          })
          // Flush what the batch already has, not only what the next maintenance
          // finds. With a 15-entry threshold a normal conversation never reached
          // a flush, so psyche sat at the same value for days while the panel
          // kept re-reading it. force=false still respects the min batch and age.
          void import('../vendor/engine/emotion')
            .then(mod => mod.flushVadQueue(project, { force: false }))
            .catch(() => {})
          return { ok: Boolean(result?.conversationSaved), mode: 'auto', details: result?.details ?? [] }
        }
        // 最小路径:conversation_log + 用户观察。两者都是本地计算,离线/无 key 也能跑。
        const saved = await store.saveConversationTurn(
          user,
          assistant,
          charId,
          undefined,
          undefined,
          project,
          turn.affect ? { status: 'analyzed' as const, source: 'model', vad: turn.affect.vad } : undefined,
        )
        try {
          const userLearning = await import('../vendor/engine/userLearning')
          userLearning.observeUserMessage(charId, 'default', user, project)
        }
        catch { /* 观察失败不能影响已落库的对话 */ }

        // 临时反思(会话滚动快照)的原料：buffer 攒到 BUFFER_SIZE(默认 5) 轮或 4000 token 后
        // 后台跑 runIncrementalReflection，写 source='session_memory' 的滚动快照(tier=temporary，
        // 7 天 TTL，由 sweepExpiredSessionMemories 清)。
        // 以前只有引擎的 autoProcess 会喂它，而 app 走的是这条最小路径 —— 实测 6 轮对话之后
        // session_memory 仍是 0 条，等于"临时反思"这条线一直空转。这里补上。
        if (turn.sessionId) {
          try {
            const buffer = await import('../vendor/engine/buffer')
            buffer.getBuffer(project, turn.sessionId, charId).onNewMessage([
              { role: 'user', content: user },
              { role: 'assistant', content: assistant },
            ])
          }
          catch { /* 缓冲失败不影响本轮落库；正常反思仍从 conversation_log 拿原料 */ }
        }
        return { ok: true, id: (saved as any)?.id, mode: 'minimal' }
      }
      catch (e: any) {
        return { ok: false, mode: fullAuto ? 'auto' : 'minimal', error: e?.message ?? String(e) }
      }
    },
    selfCycle: async (options = {}) => {
      const selfCycle = await import('../vendor/engine/selfCycle')
      return selfCycle.runSelfCycle({
        ...options,
        project,
        characterId: options.characterId ?? charId,
      })
    },
    maintain: async (options = {}) => {
      const startedAt = new Date().toISOString()
      const t0 = Date.now()
      const report: MaintainReport = { ok: true, startedAt, ms: 0, reflectConfigured: false }
      const snapshot = () => {
        const out: Record<string, number> = {}
        for (const mt of MEM_TYPES) {
          try {
            const conn = (db as any).DatabaseManager.getInstance(project, mt)
            const one = (sql: string) => { try { return Number(conn.prepare(sql).get()?.c ?? 0) } catch { return 0 } }
            out[`${mt}.active`] = one('SELECT COUNT(*) c FROM memory WHERE is_active=1')
            out[`${mt}.facts`] = one('SELECT COUNT(*) c FROM facts')
            out[`${mt}.entities`] = one('SELECT COUNT(*) c FROM entities')
          }
          catch { /* 该分类库不存在 */ }
        }
        return out
      }
      try {
        report.before = snapshot()
        const [driver, digestMod] = await Promise.all([
          import('../vendor/engine/reflectDriver'),
          import('../vendor/engine/digest'),
        ])
        report.reflectConfigured = Boolean((driver as any).isReflectConfigured?.())

        if (report.reflectConfigured) {
          // 反刍:从 conversation_log 里取未分析的对话,抽事实/洞察,写 memory+facts+entities。
          const reflect = await (driver as any).runAutoReflect(charId, options.limit ?? 30, project)
          report.reflect = {
            ok: Boolean(reflect?.ok),
            mode: reflect?.mode,
            conversationCount: reflect?.conversationCount,
            actions: reflect?.actions,
            applied: reflect?.applied,
            factsInserted: reflect?.factsInserted,
            factsUpdated: reflect?.factsUpdated,
            errors: reflect?.errors ?? [],
            deferred: reflect?.deferredCount,
          }
          if (!options.skipConsolidate) {
            // 整合:合并近重复、时间衰减、升格。critical/locked/identity_locked 不参与。
            const merged = await (driver as any).runConsolidate(charId, project, undefined, undefined, { force: true })
            report.consolidate = {
              ok: Boolean(merged?.ok),
              scanned: merged?.scanned,
              candidates: merged?.candidates,
              merged: merged?.merged,
              deleted: merged?.deleted,
              kept: merged?.kept,
              invalidated: merged?.invalidated,
              errors: merged?.errors ?? [],
            }
          }
        }
        else {
          report.reflect = { ok: false, errors: ['未配置反刍 LLM（config.json 的 reflect.api_key 为空）'] }
        }

        // 事件摘要层（P2）：独立于反刍配置，走 triage 通道；只摘录不改写、带来源 rowid。
        if (!options.skipEventDigest) {
          try {
            const eventDigestMod = await import('../vendor/engine/eventDigest')
            const events = await (eventDigestMod as any).runEventDigest({
              project,
              characterId: charId,
              days: options.eventDigestDays ?? 2,
            })
            report.eventDigest = {
              ok: Boolean(events?.ok),
              conversations: events?.conversations,
              events: events?.events,
              inserted: events?.inserted,
              updated: events?.updated,
              skipped: events?.skipped,
              errors: events?.errors ?? [],
              skippedReason: events?.skippedReason,
            }
          }
          catch (e: any) {
            report.eventDigest = { ok: false, errors: [e?.message ?? String(e)] }
          }
        }

        if (!options.skipDigest) {
          const digest = await (digestMod as any).runDigest(charId, project)
          report.digest = {
            success: Boolean(digest?.success),
            cleaned: digest?.cleaned,
            restored: digest?.restored,
            vadUpdated: digest?.vadUpdated,
            errors: digest?.errors ?? [],
          }
        }

        report.after = snapshot()
        // One boolean for the whole cycle: the reflect stage alone used to
        // decide `ok`, so a failed consolidation or digest still reported a
        // healthy maintenance and the sleep quality stayed high.
        const stages: boolean[] = []
        if (report.reflectConfigured)
          stages.push(Boolean((report.reflect as any)?.ok))
        if (report.consolidate)
          stages.push(Boolean((report.consolidate as any)?.ok))
        if (report.eventDigest) {
          // A digest with no triage model says why it did nothing; that is not
          // the same as a digest that ran and failed.
          const digestStage = report.eventDigest as any
          stages.push(Boolean(digestStage?.ok) || Boolean(digestStage?.skippedReason))
        }
        if (report.digest)
          stages.push(Boolean((report.digest as any)?.success))
        report.ok = stages.length > 0 && stages.every(Boolean)
      }
      catch (e: any) {
        report.ok = false
        report.error = e?.message ?? String(e)
      }
      report.ms = Date.now() - t0
      return report
    },
    setSelfEnergy: async (value) => {
      const { getAgentState } = await import('../vendor/engine/agentState')
      getAgentState(charId, project).setEnergy(value)
    },
    /**
     * 队列到期检查（审计 F07）。
     *
     * 只在最老一条超过 `maxAgeSec` 时强制 flush：十分钟是时限，不是"下一次有人说话再说"。
     * 队列不可用（没开 VAD）时安静返回，不算错误。
     */
    flushStaleVadQueue: async (maxAgeSec = 600) => {
      try {
        const emotion = await import('../vendor/engine/emotion')
        // Rows outlive a restart; the in-memory queue does not. Only the nightly digest rebuilt it,
        // and only for its own character, so a persona switch left its rows pending forever.
        try {
          const conn = (db as any).DatabaseManager.getInstance(project, 'general')
          const rows = conn.prepare(`
            SELECT DISTINCT character_id FROM memory
            WHERE project = ? AND source = 'conversation_log' AND is_active = 1
              AND affect_status IN ('pending', 'pending_psyche')
          `).all(project) as { character_id?: string }[]
          for (const row of rows)
            emotion.recoverPendingVadQueue(project, String(row.character_id || charId))
        }
        catch { /* recovery is best-effort; the live queue still works */ }
        // Judge the deadline across the project: a late batch under another character is still late.
        const before = emotion.vadQueueStatus(project) as { size?: number, oldestAgeSec?: number } | undefined
        const pending = before?.size ?? 0
        if (!pending || (before?.oldestAgeSec ?? 0) < maxAgeSec)
          return { updated: 0, pending }
        const flushed = await emotion.flushVadQueueDetailed(project, { force: true }) as { updated?: number } | undefined
        const after = emotion.vadQueueStatus(project) as { size?: number } | undefined
        return { updated: flushed?.updated ?? 0, pending: after?.size ?? 0 }
      }
      catch {
        return { updated: 0, pending: 0 }
      }
    },
    psycheState: async (options = {}) => {
      const { getPsycheState } = await import('../vendor/engine/psycheState')
      const state = getPsycheState(options.characterId ?? charId, options.project ?? project) as any
      return {
        characterId: options.characterId ?? charId,
        project: options.project ?? project,
        hasEvidence: Boolean(state?.hasEvidence),
        band: String(state?.band ?? 'unknown'),
        vad: {
          valence: Number(state?.vad?.valence ?? 0),
          arousal: Number(state?.vad?.arousal ?? 0),
          dominance: Number(state?.vad?.dominance ?? 0),
        },
        mood: {
          valence: Number(state?.mood?.valence ?? 0),
          arousal: Number(state?.mood?.arousal ?? 0),
          dominance: Number(state?.mood?.dominance ?? 0),
        },
        version: Number(state?.version ?? 0),
        updatedAt: Number(state?.updatedAt ?? Date.now()),
        lastEvidenceAt: Number.isFinite(state?.lastEvidenceAt) ? Number(state.lastEvidenceAt) : -1,
      } satisfies PsycheSnapshot
    },
    applyEmotion: async (input) => {
      const { applyPsycheAppraisal, getPsycheState, targetAppraisalFromVAD } = await import('../vendor/engine/psycheState')
      const character = input.characterId ?? charId
      const proj = input.project ?? project
      const at = Number.isFinite(input.at) ? Number(input.at) : Date.now()
      // 幂等键由调用方给：同一轮重试必须落在同一个 id 上，否则同一句话的情绪会累加两次。
      const eventId = input.eventId ?? `emotion:llm:${proj}:${character}:${at}`
      const appraisal = targetAppraisalFromVAD(input.vad, eventId, { allowPartial: true })
      const before = Number(getPsycheState(character, proj, at)?.version ?? 0)
      if (appraisal.kind !== 'target')
        return { applied: false, reason: appraisal.kind as ApplyEmotionResult['reason'], version: before }
      let next
      try {
        // 显式情绪的目的就是让引擎的状态机动起来，所以要求必须落库：写失败却报 applied，
        // 重启后这次情绪就凭空消失了。
        next = applyPsycheAppraisal(character, proj, appraisal, at, { requirePersistence: true })
      }
      catch {
        return { applied: false, reason: 'persist_failed', version: before }
      }
      return { applied: Number(next.version) > before, reason: 'applied', version: Number(next.version) }
    },
    close: () => { current = null },
  }

  current = handle

  // 冷启动预热：实测第一次 recall 要 597ms（建连+调用嵌入 API），热了只要 43ms。
  // 注入层有 300ms 死线，所以会话第一轮的记忆块会被静默丢掉 —— 表现为"她翻遍小本本也没找到"。
  // 这里在后台焐一次，别让用户的第一句话撞在冷启动上。
  void (async () => {
    try {
      await inject.recallForInjection('预热', { project, characterId: charId, topK: 1 })
    }
    catch { /* 预热失败不影响任何功能，真正的召回会再试一次 */ }
  })()

  return handle
}
