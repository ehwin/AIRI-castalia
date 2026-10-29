// NOTICE: 进程内记忆体入口（AIRI 插件层）。
// why: 之前 app 通过 stdio/HTTP 客户端连 CastaliaNode 子进程；这里改成在主进程内直接跑引擎
//      的存储/检索代码，用 node:sqlite + sqlite-vec，不再需要子进程或端口。
// 安全约束（踩过坑）: 以写模式打开真实库时**必须**带上该库的 config.json —— 引擎会对比
//      嵌入空间哈希，配置缺失会被判定为"换了嵌入模型"从而清空派生索引（向量/片段）。
//      下面的 openBank 因此强制校验 config，缺失直接抛错，不给静默清库的机会。
// 移除条件: 引擎提供稳定的、无环境变量耦合的工厂 API 后，这层可以退化成薄包装。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

export interface BankHandle {
  bankDir: string
  project: string
  charId: string
  engineVersion: string
  save: (params: Record<string, unknown>) => Promise<any>
  search: (options: Record<string, unknown>) => Promise<any[]>
  recent: (limit?: number) => any[]
  recall: (query: string, options?: Record<string, unknown>) => Promise<any>
  forget: (id: string, reason?: string) => any
  restore: (id: string) => any
  stats: () => Array<{ memType: string, active: number, vec: number, chunk: number }>
  /** memory_store_list 的进程内版本（源 = 引擎的 store 工具实现） */
  listStore: (args?: Record<string, unknown>) => { records: any[] }
  saveStore: (args: Record<string, unknown>) => Promise<{ id: string, updated: boolean }>
  forgetStore: (args: Record<string, unknown>) => { deleted: boolean }
  /** memory_recall 的进程内版本（含注入渲染与门槛） */
  recallQuery: (query: string, args?: Record<string, unknown>) => Promise<any>
  /** 会话对账:把指向"已不存在会话"的记忆软删(is_active=0),防孤儿。默认 dryRun */
  orphanSessions: (args: { aliveSessionIds: string[], dryRun?: boolean }) => Array<{ memType: string, orphans: number, orphaned: number }>
  /** 各会话下有多少条活跃记忆(审计用) */
  sessionInventory: () => Array<{ memType: string, sessions: Array<{ sessionId: string, memories: number, latest: string }> }>
  close: () => void
}

/** 记忆分类库(与引擎 memType 目录一致):孤儿对账要逐库跑 */
const MEM_TYPES = ['general', 'user', 'project', 'reference', 'feedback'] as const

let current: BankHandle | null = null

export function currentBank(): BankHandle | null {
  return current
}

/**
 * 在主进程内打开一个记忆体库。
 * 注意：引擎的 DatabaseManager 是进程级单例，一次只能绑定一个 bank/project；
 * 换库需要重开进程（或先 close 再换 env，引擎内部的实例缓存不会释放）。
 */
export async function openBank(options: OpenBankOptions): Promise<BankHandle> {
  const bankDir = options.bankDir.replace(/\\/g, '/')
  const project = options.project
  const charId = options.charId ?? 'airi'
  const configPath = options.configPath ?? join(bankDir, 'config.json')

  if (!existsSync(bankDir)) throw new Error(`[castalia-bank] bank dir 不存在: ${bankDir}`)

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
  const orphan = await import('../vendor/engine/orphan')
  // store 工具（memory_store_list/save/forget + memory_recall 的进程内版本）
  const { createStoreTools, loadEngineDeps } = await import('./store-tools')
  const storeTools = createStoreTools(await loadEngineDeps())

  const handle: BankHandle = {
    bankDir,
    project,
    charId,
    engineVersion: (version as any).VERSION ?? 'unknown',
    // VAD 由引擎 store.saveMemory 在写路径补(见 vendor/engine/store.ts),宿主层不重复写一次。
    save: params => store.saveMemory(params as any),
    search: options2 => search.searchMemory(options2 as any),
    // 签名: getRecentMemories(characterId, limit, hoursBack, project?, memType?)
    recent: (limit = 5) => search.getRecentMemories(charId, limit, 24 * 365, project) as any[],
    recall: (query, o) => inject.recallForInjection(query, o as any),
    // 签名: forgetMemory(id, project?, characterId?) —— 第二参是项目名，不是原因
    forget: id => store.forgetMemory(id, project, charId),
    restore: id => store.restoreMemory(id, project, charId),
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
    close: () => { current = null },
  }

  current = handle
  return handle
}
