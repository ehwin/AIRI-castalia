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

import { openBank } from '@proj-airi/castalia-plugin/bank'

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) 和 ISO 都转 epoch ms（与 stdio 版行为一致）。 */
function parseTime(value: string | undefined): number {
  if (!value)
    return Date.now()
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export function createInProcessBankMemory(options: CastaliaEngineOptions): CastaliaEngineMemory {
  let opened: Promise<Awaited<ReturnType<typeof openBank>>> | undefined
  let closing = false

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
      const { records } = bank.listStore({ allCharacters: true, source: 'airi', limit: 2000 })
      return records
        .filter(row => typeof row.name === 'string' && row.name.length > 0)
        .map(row => ({
          name: String(row.name),
          description: row.description ?? '',
          body: row.body ?? '',
          ...(row.general ? {} : { persona: row.characterId || undefined }),
          updatedAt: parseTime(row.updatedAt ?? row.createdAt),
        } as CastaliaMemoryEntry))
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
      const result = await bank.recallQuery(query)
      return {
        text: result.text ?? '',
        count: result.stats?.count ?? 0,
        topSim: result.stats?.topSim ?? 0,
        chars: result.stats?.chars ?? 0,
      }
    },

    async close() {
      closing = true
      const bank = await opened?.catch(() => undefined)
      opened = undefined
      bank?.close()
    },
  }
}
