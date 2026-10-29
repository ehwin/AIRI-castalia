// NOTICE: 从引擎 MCP 入口（src/index.ts）搬出来的 4 个 store 工具，改成进程内函数。
// why: 这 4 个工具原先只以 MCP 工具形式存在（app 走 stdio 子进程调用）；插件化后要在主进程
//      直接调用，所以把 handler 实现原样移植（逻辑逐行对齐上游，便于比对）。
// 上游: castalia/Castalia-Anima/src/index.ts 的 memory_store_list/save/forget + memory_recall。
// 改动: 只把 ok()/err() 的 MCP content 信封换成普通对象；查询/写入语义不动。
// 重要: 这里**不能**静态 import 引擎模块 —— 引擎在模块求值时读 process.env
//      （CHAR_ID / EMBED_MODE / MEMORY_DB_DIR …），必须在 openBank() 设好环境后再加载，
//      所以统一走 loadEngineDeps() 动态导入 + createStoreTools() 工厂。
// 移除条件: 引擎把这 4 个 handler 拆成可 import 的函数。
export interface EngineDeps {
  DatabaseManager: {
    getInstance: (project?: string, memType?: string) => any
  }
  listMemTypeDirs: (project: string) => string[]
  CHAR_ID: string
  PROJECT_ID: string
  normalizeProject: (project?: string) => string
  saveMemory: (params: any) => Promise<{ id: string }>
  updateMemory: (id: string, updates: any, characterId?: string) => Promise<unknown>
  forgetMemory: (id: string, project?: string, characterId?: string) => boolean
  recallForInjection: (query: string, options?: any) => Promise<any>
  parseTagsSafe: (raw: unknown) => string[]
}

export async function loadEngineDeps(): Promise<EngineDeps> {
  const [db, env, store, inject, tags] = await Promise.all([
    import('../vendor/engine/db'),
    import('../vendor/engine/env'),
    import('../vendor/engine/store'),
    import('../vendor/engine/recallForInjection'),
    import('../vendor/engine/tags'),
  ])
  return {
    DatabaseManager: (db as any).DatabaseManager,
    listMemTypeDirs: (db as any).listMemTypeDirs,
    CHAR_ID: (env as any).CHAR_ID,
    PROJECT_ID: (env as any).PROJECT_ID,
    normalizeProject: (env as any).normalizeProject,
    saveMemory: (store as any).saveMemory,
    updateMemory: (store as any).updateMemory,
    forgetMemory: (store as any).forgetMemory,
    recallForInjection: (inject as any).recallForInjection,
    parseTagsSafe: (tags as any).parseTagsSafe,
  }
}

const STORE_SOURCE = 'airi'
const STORE_NAME_RE = /^#\s+([^\n]+)\n?/

export interface StoreRecord {
  id: string
  name: string | null
  fallbackName?: string
  description: string
  body: string
  characterId: string
  general: boolean
  memType: string
  source: string
  tags: string[]
  importance?: number
  createdAt?: string
  updatedAt?: string
}

export interface ListArgs {
  project?: string
  characterId?: string
  includeGeneral?: boolean
  allCharacters?: boolean
  source?: string
  limit?: number
}

export interface SaveArgs {
  name: string
  description?: string
  body: string
  characterId?: string
  general?: boolean
  project?: string
  importance?: number
}

export interface ForgetArgs {
  name: string
  characterId?: string
  general?: boolean
  project?: string
}

export interface RecallArgs {
  project?: string
  characterId?: string
  topK?: number
  minSimilarity?: number
  capChars?: number
  /** 最近几轮已注入的 id(宿主维护):连续同话题不重复塞同一段 */
  recentIds?: string[]
  /** top1-top2 落差阈值:只降 uncertainty,不丢结果 */
  margin?: number
  log?: boolean
}

export function parseStoreText(text: string): { name: string | null, description: string, body: string } {
  const m = STORE_NAME_RE.exec(text)
  if (!m)
    return { name: null, description: '', body: text }
  const rest = text.slice(m[0].length)
  const nl = rest.indexOf('\n')
  const description = (nl === -1 ? rest : rest.slice(0, nl)).trim()
  const body = nl === -1 ? '' : rest.slice(nl + 1).replace(/^\n/, '')
  return { name: m[1].trim(), description, body }
}

export function createStoreTools(deps: EngineDeps) {
  const { DatabaseManager, listMemTypeDirs, CHAR_ID, PROJECT_ID, normalizeProject } = deps

  function storeCharacterId(args: { characterId?: string, general?: boolean }): string {
    if (args.general)
      return ''
    return (args.characterId ?? '').trim() || CHAR_ID
  }

  function toStoreRecord(row: any): StoreRecord {
    const parsed = parseStoreText(String(row.text ?? ''))
    const charId = row.character_id ?? null
    return {
      id: row.id,
      ...parsed,
      fallbackName: parsed.name ? undefined : `mem-${String(row.id).slice(0, 8)}`,
      characterId: charId ?? '',
      general: !charId,
      memType: row.mem_type || 'general',
      source: row.source ?? '',
      tags: deps.parseTagsSafe(row.tags),
      importance: row.importance,
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? row.created_at,
    }
  }

  function readStoreRows(
    project: string | undefined,
    characterId: string,
    includeGeneral: boolean,
    limit: number,
    opts: { allCharacters?: boolean, source?: string } = {},
  ): { project: string, rows: any[] } {
    const proj = normalizeProject(project ?? PROJECT_ID)
    const cap = Math.max(1, Math.min(Math.trunc(limit) || 500, 2000))
    const conditions = ['is_active = 1']
    const params: any[] = []
    if (opts.allCharacters) {
      // 前端重建缓存：只按 source 圈定写入方，不按角色过滤
    }
    else if (characterId === '') {
      conditions.push('(character_id IS NULL OR character_id = \'\')')
    }
    else if (includeGeneral) {
      conditions.push('(character_id = ? OR character_id IS NULL OR character_id = \'\')')
      params.push(characterId)
    }
    else {
      conditions.push('character_id = ?')
      params.push(characterId)
    }
    if (opts.source) {
      conditions.push('source = ?')
      params.push(opts.source)
    }
    const rows: any[] = []
    for (const mt of listMemTypeDirs(proj)) {
      try {
        const db = DatabaseManager.getInstance(proj, mt)
        const found = db.prepare(`
          SELECT id, text, character_id, mem_type, tags, importance, source, created_at, updated_at
          FROM memory WHERE ${conditions.join(' AND ')}
          ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?
        `).all(...params, cap) as any[]
        for (const r of found) rows.push({ ...r, mem_type: r.mem_type || mt })
      }
      catch { /* 单个分类库损坏不阻断 */ }
    }
    rows.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)))
    return { project: proj, rows: rows.slice(0, cap) }
  }

  return {
    listStoreEntries(args: ListArgs = {}): { project: string, characterId: string, records: StoreRecord[] } {
      const charId = storeCharacterId(args)
      const { project, rows } = readStoreRows(
        args.project,
        charId,
        args.includeGeneral !== false,
        args.limit ?? 500,
        { allCharacters: args.allCharacters, source: args.source },
      )
      return { project, characterId: charId, records: rows.map(toStoreRecord) }
    },

    async saveStoreEntry(args: SaveArgs): Promise<{ id: string, name: string, updated: boolean, text: string }> {
      const charId = storeCharacterId(args)
      const name = String(args.name).trim()
      const description = (args.description ?? '').trim()
      const body = String(args.body).trim()
      if (!name || !body)
        throw new Error('name 和 body 不能为空')
      const text = description ? `# ${name}\n${description}\n\n${body}` : `# ${name}\n\n${body}`
      const { project, rows } = readStoreRows(args.project, charId, false, 2000)
      const existing = rows.find(row => parseStoreText(String(row.text ?? '')).name === name)
      if (existing) {
        const r = await deps.updateMemory(String(existing.id), { text, project }, charId)
        if (!r)
          throw new Error('已有同名记忆但更新失败')
        return { id: String(existing.id), name, updated: true, text }
      }
      const r = await deps.saveMemory({
        text,
        project,
        memType: 'general',
        type: 'episodic',
        source: STORE_SOURCE,
        subject: 'self',
        importance: args.importance ?? 0.5,
        characterId: charId,
      })
      return { id: r.id, name, updated: false, text }
    },

    forgetStoreEntry(args: ForgetArgs): { deleted: boolean, id?: string } {
      const charId = storeCharacterId(args)
      const name = String(args.name).trim()
      const { project, rows } = readStoreRows(args.project, charId, false, 2000)
      const existing = rows.find(row => parseStoreText(String(row.text ?? '')).name === name)
      if (!existing)
        return { deleted: false }
      const deleted = deps.forgetMemory(String(existing.id), project, charId)
      return { deleted, id: String(existing.id) }
    },

    async recallForQuery(query: string, options: RecallArgs = {}) {
      const charId = (options.characterId ?? '').trim() || CHAR_ID
      const project = normalizeProject(options.project ?? PROJECT_ID)
      const result = await deps.recallForInjection(String(query), {
        project,
        characterId: charId,
        topK: options.topK,
        minSimilarity: options.minSimilarity,
        capChars: options.capChars,
        recentIds: options.recentIds,
        margin: options.margin,
        log: options.log,
      })
      return { project, characterId: charId, ...result }
    },
  }
}

export type StoreTools = ReturnType<typeof createStoreTools>
