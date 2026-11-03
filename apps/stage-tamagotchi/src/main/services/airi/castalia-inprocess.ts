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

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) 和 ISO 都转 epoch ms（与 stdio 版行为一致）。 */
function parseTime(value: string | undefined): number {
  if (!value)
    return Date.now()
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

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

export function createInProcessBankMemory(options: CastaliaEngineOptions): CastaliaEngineMemory {
  let opened: Promise<Awaited<ReturnType<typeof openBank>>> | undefined
  let closing = false
  // 最近几轮注入过的记忆 id:连续同话题时不重复塞同一段(报告里"连续 3 轮不重复"那条)。
  let recentIds: string[] = []

  function ensure() {
    if (!opened) {
      opened = openBank({
        bankDir: options.bankDir,
        project: options.project,
        charId: options.character,
      })
    }
    return opened
  }

  return {
    async list() {
      if (closing)
        return []
      const bank = await ensure()
      // 长期记忆页要看到"库里的全部记忆"，不是 app 自己写的那几条 store 条目
      return bank.listMemories(2000)
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
            updatedAt: parseTime(row.updatedAt),
          } as CastaliaMemoryEntry
        })
    },

    async save(entry) {
      if (closing)
        return
      const bank = await ensure()
      await bank.saveStore({
        name: entry.name,
        description: entry.description,
        body: entry.body,
        ...(entry.persona ? { characterId: entry.persona } : { general: true }),
      })
    },

    async forget(entry) {
      if (closing)
        return false
      const bank = await ensure()
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

    async recall(query): Promise<CastaliaRecalledMemory> {
      if (closing)
        return { text: '', count: 0, topSim: 0, chars: 0 }
      const bank = await ensure()
      const result = await bank.recallQuery(query, { recentIds })
      const ids = (result.stats as { ids?: string[] } | undefined)?.ids ?? []
      recentIds = [...recentIds, ...ids].slice(-10)   // 只记最近 10 条,不至于整库都被排掉
      return {
        text: result.text ?? '',
        count: result.stats?.count ?? 0,
        topSim: result.stats?.topSim ?? 0,
        chars: result.stats?.chars ?? 0,
      }
    },

    async search(query, topK = 5) {
      if (closing)
        return []
      const bank = await ensure()
      const rows = await bank.search({
        query,
        topK,
        project: options.project,
        characterId: options.character,
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

    async ingest(turn) {
      if (closing)
        return { ok: false, error: 'closing' }
      const bank = await ensure()
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
      const bank = await ensure()
      return bank.maintain(options)
    },

    async setSelfEnergy(value) {
      if (closing)
        return
      const bank = await ensure()
      return bank.setSelfEnergy(value)
    },
    async psycheState(options) {
      if (closing)
        return null
      const bank = await ensure()
      return bank.psycheState(options ?? {})
    },

    async selfCycle(input) {
      if (closing)
        return { ok: false, skipped: true, reason: 'closing', evidenceIds: [], project: input?.project ?? '' }
      const bank = await ensure()
      const result = await bank.selfCycle(input)
      // 日记正文只在 project 库里、且只有 id 能对上。这一读走只读连接（WAL 允许并发读），
      // 用来回答「她刚才到底想了什么」—— mind 把它变成一条内部念头。
      if (result?.ok && !result.skipped && result.diaryId)
        return { ...result, diaryText: readDiaryText({ bankDir: options.bankDir, project: options.project }, result.diaryId) }
      return result
    },

    async close() {
      closing = true
      const bank = await opened?.catch(() => undefined)
      opened = undefined
      bank?.close()
    },
  }
}
