// NOTICE: 进程内记忆后端（插件直连，不再 spawn CastaliaNode、不再走 MCP/HTTP）。
// why: 之前 app 用 StdioClientTransport 拉一个子进程，理由是引擎的 better-sqlite3 按 Node 137 编、
//      在 Electron(148) 里打不开。实测 Electron 内置 node:sqlite 能开同一个库并挂 sqlite-vec，
//      所以引擎代码可以直接在主进程跑（见 packages/castalia-plugin/src/bank）。
// 关键: 只能从这里 import openBank —— 引擎模块在求值时读 process.env，openBank 内部会先设好
//      环境再动态加载，所以**不要**在文件顶部静态 import 任何 vendor/engine 或 store-tools。
// 保留: stdio 路径仍可用（CASTALIA_MEMORY_TRANSPORT=stdio），Full 总线/桥不受影响。
import type { CastaliaMemoryEntry } from '@proj-airi/castalia-plugin/memory'

import type { CastaliaRecalledMemory } from '../../../shared/eventa/castalia-memory'
import type { CastaliaEngineMemory, CastaliaEngineOptions } from './castalia-engine'

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { openBank } from '@proj-airi/castalia-plugin/bank'
import { parseStoreText } from '@proj-airi/castalia-plugin/bank/store-tools'
import { parseBankTime } from '@proj-airi/castalia-plugin/bank/time'

/**
 * 按 id 读一条日记的正文。
 *
 * 为什么直连库而不是问引擎：日记写在 `project` 分类库里，引擎的 `memory_get` 按 agent 的
 * memType 目录找，实测返回 NOT_FOUND；而这里只读一行，代价可以忽略。读失败一律返回
 * undefined —— 拿不到正文不该让「她刚想过」这件事变成错误。
 */
function readDiaryText(options: { bankDir: string, project: string } | undefined, diaryId: string): string | undefined {
  try {
    const bankDir = options?.bankDir
    const project = options?.project
    if (!bankDir || !project)
      return undefined
    const file = join(bankDir, project, 'project', 'memory.sqlite')
    if (!existsSync(file))
      return undefined
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT text FROM memory WHERE id = ?').get(diaryId) as { text?: string } | undefined
      const text = typeof row?.text === 'string' ? row.text.trim() : ''
      return text || undefined
    }
    finally {
      db.close()
    }
  }
  catch {
    return undefined
  }
}

/** 列表上限。撞到它会显式报 truncated，而不是安静地少给。 */
const LIST_LIMIT = 2000

export function createInProcessBankMemory(options: CastaliaEngineOptions): CastaliaEngineMemory {
  // One bank per character: the handle binds `charId` when it opens, so a second card needs its
  // own handle. Sharing one made search read the configured character while the write went to the
  // card on screen (audit F01).
  const banks = new Map<string, Promise<Awaited<ReturnType<typeof openBank>>>>()
  let closing = false
  // 最近几轮注入过的记忆 id:连续同话题时不重复塞同一段(报告里"连续 3 轮不重复"那条)。
  let recentIds: string[] = []

  /** 配置里的角色：没有任何卡被打开时，维护与自循环退回它。 */
  const configuredCharacter = options.character

  /** The bank for one character, opened once and reused. A missing persona keeps the configured one. */
  function ensure(persona?: string) {
    const character = persona?.trim() || options.character
    const existing = banks.get(character)
    if (existing)
      return existing
    // A rejected open used to stay in the map, so one transient failure (a WAL lock at start)
    // failed every later call for that character until the app restarted.
    const guarded: ReturnType<typeof openBank> = openBank({
      bankDir: options.bankDir,
      project: options.project,
      charId: character,
      // 内置默认库没有 config.json：允许无配置打开（固定 FTS），否则全新安装一开库就抛错。
      ...(options.allowNoConfig ? { allowNoConfig: true } : {}),
    }).catch((error) => {
      if (banks.get(character) === guarded)
        banks.delete(character)
      throw error
    })
    banks.set(character, guarded)
    return guarded
  }

  let listState: { listed: number, truncated: boolean } | undefined

  return {
    listStats: () => listState,
    async list() {
      if (closing)
        return []
      const bank = await ensure()
      // 长期记忆页要看到"库里的全部记忆"，不是 app 自己写的那几条 store 条目
      const rows = bank.listMemories(LIST_LIMIT)
      // 撞到上限就说明"看到的不是全部"：静默截断会让面板和模型都以为库就这么大。
      listState = { listed: rows.length, truncated: rows.length >= LIST_LIMIT }
      if (listState.truncated)
        console.warn(`[castalia] memory list hit the ${LIST_LIMIT}-row cap; the panel and the index see a subset`)
      return rows
        .map((row) => {
          const raw = String(row.text ?? '')
          const parsed = parseStoreText(raw)
          const name = parsed.name ?? `mem-${row.id.slice(0, 8)}`
          return {
            id: row.id,
            name,
            description: parsed.name ? parsed.description : raw.replace(/\s+/g, ' ').slice(0, 80),
            body: parsed.name ? parsed.body : raw,
            ...(row.characterId ? { persona: row.characterId } : {}),
            updatedAt: parseBankTime(row.updatedAt),
          } as CastaliaMemoryEntry
        })
    },

    async save(entry) {
      if (closing)
        return
      const bank = await ensure(entry.persona)
      await bank.saveStore({
        name: entry.name,
        description: entry.description,
        body: entry.body,
        ...(entry.persona ? { characterId: entry.persona } : { general: true }),
      })
    },

    async rememberDay(day) {
      if (closing)
        return { ok: false, reason: 'closed' }
      const bank = await ensure(day.persona)
      try {
        await bank.saveDiaryDay({
          date: day.date,
          description: day.description,
          body: day.body,
          characterId: day.persona?.trim() || options.character,
        })
        return { ok: true }
      }
      catch (error) {
        return { ok: false, reason: String((error as Error)?.message ?? error) }
      }
    },

    async searchDiary(query, topK = 5, persona) {
      if (closing)
        return []
      const bank = await ensure(persona)
      const rows = await bank.searchDiary(String(query), {
        topK,
        characterId: persona?.trim() || options.character,
      }) as Array<{ id?: string, text?: string, score?: number, memType?: string, category?: string, createdAt?: string }>
      return (Array.isArray(rows) ? rows : [])
        .filter(row => typeof row.text === 'string' && row.text.trim().length > 0)
        .map(row => ({
          ...(row.id ? { id: String(row.id) } : {}),
          text: String(row.text),
          score: typeof row.score === 'number' ? row.score : 0,
          ...(row.memType ? { memType: String(row.memType) } : {}),
          ...(row.category ? { category: String(row.category) } : {}),
          ...(row.createdAt ? { createdAt: String(row.createdAt) } : {}),
        }))
    },

    async rememberThoughts(rows) {
      if (closing)
        return { ok: false, reason: 'closed' }
      const list = Array.isArray(rows) ? rows : []
      if (!list.length)
        return { ok: true, saved: 0 }
      try {
        const persona = list.find(row => row.persona?.trim())?.persona?.trim() || undefined
        const bank = await ensure(persona)
        const result = await bank.saveThoughts(list.map(row => ({
          id: String(row.id),
          at: Number(row.at) || Date.now(),
          text: String(row.text ?? ''),
          visibility: row.visibility === 'shared' ? 'shared' as const : 'private' as const,
          ...(row.topic ? { topic: String(row.topic) } : {}),
          persona: row.persona?.trim() || options.character,
        })))
        return { ok: true, saved: result.saved }
      }
      catch (error) {
        return { ok: false, reason: String((error as Error)?.message ?? error) }
      }
    },

    async listThoughts(options_ = {}) {
      if (closing)
        return []
      const bank = await ensure(options_.persona)
      return bank.listThoughts({
        limit: options_.limit,
        characterId: options_.persona?.trim() || options.character,
      })
    },

    async forget(entry) {
      if (closing)
        return false
      const bank = await ensure(entry.persona)
      // 有 id 直接按行删（覆盖库里所有记忆）；否则回退到按 store 名删
      if (entry.id)
        return Boolean(bank.forget(entry.id))
      if (!entry.name)
        return false
      const { deleted } = bank.forgetStore({
        name: entry.name,
        ...(entry.persona ? { characterId: entry.persona } : { general: true }),
      })
      return deleted
    },

    async recall(query, persona): Promise<CastaliaRecalledMemory> {
      if (closing)
        return { text: '', count: 0, topSim: 0, chars: 0 }
      const bank = await ensure(persona)
      // 召回也要带上提问的卡：不带时 store-tools 会退回引擎启动时捕获的 CHAR_ID，
      // 于是第二张卡的自动召回拿到的是第一张卡的记忆（审计 A01）。
      const result = await bank.recallQuery(query, {
        recentIds,
        characterId: persona?.trim() || options.character,
      })
      const ids = (result.stats as { ids?: string[] } | undefined)?.ids ?? []
      recentIds = [...recentIds, ...ids].slice(-10) // 只记最近 10 条,不至于整库都被排掉
      return {
        text: result.text ?? '',
        count: result.stats?.count ?? 0,
        topSim: result.stats?.topSim ?? 0,
        chars: result.stats?.chars ?? 0,
      }
    },

    async search(query, topK = 5, persona) {
      if (closing)
        return []
      const bank = await ensure(persona)
      const rows = await bank.search({
        query,
        topK,
        project: options.project,
        // The asking card wins over the configured one: the handle is opened per persona already,
        // and an explicit override keeps the two in step (audit F01).
        characterId: persona?.trim() || options.character,
        // The index, `read`, and the settings list all show the general entries, so a lookup that
        // hid them answered "nothing matched" about a row the owner could see (audit F08).
        includeGeneral: true,
      }) as Array<{ id?: string, text?: string, score?: number, memType?: string, category?: string, createdAt?: string }>
      return (Array.isArray(rows) ? rows : [])
        .filter(row => typeof row.text === 'string' && row.text.trim().length > 0)
        .map(row => ({
          ...(row.id ? { id: String(row.id) } : {}),
          text: String(row.text),
          score: typeof row.score === 'number' ? row.score : 0,
          ...(row.memType ? { memType: String(row.memType) } : {}),
          ...(row.category ? { category: String(row.category) } : {}),
          ...(row.createdAt ? { createdAt: String(row.createdAt) } : {}),
        }))
    },

    async facts(query, topK = 3, persona) {
      if (closing)
        return []
      const bank = await ensure(persona)
      const rows = await bank.facts(query, { topK }) as Array<{ subject?: string, predicate?: string, object?: string, confidence?: number, similarity?: number }>
      return (Array.isArray(rows) ? rows : [])
        .filter(row => typeof row.object === 'string' && row.object.trim().length > 0)
        .map(row => ({
          subject: String(row.subject ?? ''),
          predicate: String(row.predicate ?? ''),
          object: String(row.object ?? ''),
          confidence: typeof row.confidence === 'number' ? row.confidence : 0,
          ...(typeof row.similarity === 'number' ? { similarity: row.similarity } : {}),
        }))
    },

    async ingest(turn) {
      if (closing)
        return { ok: false, error: 'closing' }
      const bank = await ensure(turn.persona)
      try {
        const result = await bank.ingestTurn(turn)
        if (!result.ok)
          console.warn('[castalia] ingestTurn failed:', result.error ?? 'unknown')
        return result
      }
      catch (error) {
        // 写回失败不能影响已经发出去的回复:只记日志,把结果交回调用方。
        console.warn('[castalia] ingestTurn threw:', (error as Error).message)
        return { ok: false, error: (error as Error).message }
      }
    },

    async maintain(options) {
      if (closing)
        return { ok: false, startedAt: new Date().toISOString(), ms: 0, reflectConfigured: false, error: 'closing' }
      // 每个已打开的角色各跑一遍：维护只做配置角色时，第二张卡的对话写进来了却没人整理
      // （审计 A07）。没有任何角色被打开时，退回配置角色。
      const characters = new Set([configuredCharacter, ...banks.keys()])
      const startedAt = new Date().toISOString()
      let report: Awaited<ReturnType<Awaited<ReturnType<typeof openBank>>['maintain']>> | undefined
      for (const character of characters) {
        const bank = await ensure(character)
        const one = await bank.maintain(options)
        report = report
          ? { ...one, ok: report.ok && one.ok, ms: (report.ms ?? 0) + (one.ms ?? 0) }
          : one
      }
      return report ?? { ok: true, startedAt, ms: 0, reflectConfigured: false }
    },

    async setSelfEnergy(value, persona) {
      if (closing)
        return
      const bank = await ensure(persona)
      return bank.setSelfEnergy(value)
    },
    async psycheState(options) {
      if (closing)
        return null
      const bank = await ensure(options?.characterId)
      return bank.psycheState(options ?? {})
    },

    async applyEmotion(input) {
      if (closing)
        return { applied: false, reason: 'closing' as const, version: 0 }
      // 情绪必须写进这张卡自己的库：没有角色时引擎会落到配置角色上，第二张卡就串了（审计 F01）。
      const bank = await ensure(input?.persona)
      return bank.applyEmotion({ ...input, characterId: input?.persona })
    },

    async selfCycle(input) {
      if (closing)
        return { ok: false, skipped: true, reason: 'closing', evidenceIds: [], project: input?.project ?? '' }
      // 主进程排的自循环没有带角色时会落到配置角色上；第二张卡就永远轮不到（审计 A07）。
      // 没有显式角色时，按已打开的角色各跑一次，返回第一条真正跑了的结果。
      if (!input?.characterId && banks.size) {
        let fallback: Awaited<ReturnType<Awaited<ReturnType<typeof openBank>>['selfCycle']>> | undefined
        for (const character of banks.keys()) {
          const bank = await ensure(character)
          const result = await bank.selfCycle({ ...input, characterId: character })
          if (result && !result.skipped) {
            if (result.ok && result.diaryId)
              return { ...result, diaryText: readDiaryText({ bankDir: options.bankDir, project: options.project }, result.diaryId) }
            return result
          }
          fallback = fallback ?? result
        }
        if (fallback)
          return fallback
      }
      const bank = await ensure(input?.characterId)
      const result = await bank.selfCycle(input)
      // 日记正文只在 project 库里、且只有 id 能对上。这一读走只读连接（WAL 允许并发读），
      // 用来回答「她刚才到底想了什么」—— mind 把它变成一条内部念头。
      if (result?.ok && !result.skipped && result.diaryId)
        return { ...result, diaryText: readDiaryText({ bankDir: options.bankDir, project: options.project }, result.diaryId) }
      return result
    },

    async flushStaleVadQueue(maxAgeSec = 600) {
      if (closing)
        return { updated: 0, pending: 0 }
      const characters = new Set([options.character, ...banks.keys()])
      let updated = 0
      let pending = 0
      for (const character of characters) {
        const bank = await ensure(character)
        const result = await bank.flushStaleVadQueue(maxAgeSec)
        updated += result.updated
        pending += result.pending
      }
      return { updated, pending }
    },

    async close() {
      closing = true
      const opened = [...banks.values()]
      banks.clear()
      for (const pending of opened)
        (await pending.catch(() => undefined))?.close()
    },
  }
}
