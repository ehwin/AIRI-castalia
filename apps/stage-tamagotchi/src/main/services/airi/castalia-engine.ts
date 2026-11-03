import type { CastaliaMemoryEntry } from '@proj-airi/castalia-plugin/memory'

import type { CastaliaRecalledMemory, CastaliaSearchedFact, CastaliaSearchedMemory } from '../../../shared/eventa/castalia-memory'

import process from 'node:process'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * The engine-backed local memory: AIRI's memories live in the Castalia memory bank
 * instead of `userData/castalia/memory.sqlite`, so every other client of the same
 * bank (SillyTavern bridge, DSH, the star map) reads and writes the same rows.
 *
 * One engine process serves the store: rows are addressed by `characterId`, so a
 * single process holds every card's memories and the card id stays the owner.
 */

export interface CastaliaEngineOptions {
  /** Absolute path to the Castalia engine's `dist/index.js`. */
  engineEntry: string
  /** The memory bank directory (`<banks>/airi`). */
  bankDir: string
  /** Project namespace inside the bank. */
  project: string
  /** CHAR_ID of the store connection. Rows are addressed explicitly, so this only labels the process. */
  character: string
  /** Node runtime for the engine. Must match the ABI the engine's native modules were built for. */
  nodeBinary: string
}

interface CastaliaEngineConfigFile {
  enabled?: boolean
  engineEntry?: string
  bankDir?: string
  project?: string
  character?: string
  nodeBinary?: string
}

/**
 * The engine and the bank live outside AIRI, so their paths come from
 * `<userData>/castalia-engine.json` or the environment. There is no built-in
 * default: a path from one machine must never ship in the bundle.
 */

/** Reads `<userData>/castalia-engine.json`; a missing or malformed file counts as empty. */
export function readCastaliaEngineConfig(userDataDir: string): CastaliaEngineConfigFile {
  const file = join(userDataDir, 'castalia-engine.json')
  if (!existsSync(file))
    return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF+/, '')) as CastaliaEngineConfigFile
  }
  catch {
    return {}
  }
}

/**
 * Resolves the engine backend, or `undefined` when AIRI should keep the local SQLite file.
 * Disabled by `{"enabled": false}`, or when the engine/bank paths do not exist.
 */
export function resolveCastaliaEngineOptions(userDataDir: string): CastaliaEngineOptions | undefined {
  const config = readCastaliaEngineConfig(userDataDir)
  if (config.enabled === false)
    return undefined
  const engineEntry = process.env.CASTALIA_ENGINE_ENTRY || config.engineEntry
  const bankDir = process.env.CASTALIA_BANK_DIR || config.bankDir
  if (!engineEntry || !bankDir)
    return undefined
  if (!existsSync(engineEntry) || !existsSync(bankDir))
    return undefined
  const nodeBinary = process.env.CASTALIA_NODE || config.nodeBinary || 'node'
  return {
    engineEntry,
    bankDir,
    project: process.env.CASTALIA_PROJECT || config.project || 'airi',
    character: config.character || 'airi',
    nodeBinary,
  }
}

interface EngineStoreRow {
  id?: string
  name?: string
  fallbackName?: string
  description?: string
  body?: string
  characterId?: string
  general?: boolean
  updatedAt?: string
  createdAt?: string
}

/** One row of the engine's `memory_search` result. */
interface EngineSearchRow {
  id?: string
  text?: string
  score?: number
  memType?: string
  category?: string
  createdAt?: string
}

/** One row of the engine's `fact_search` result. */
interface EngineFactRow {
  subject?: string
  predicate?: string
  object?: string
  confidence?: number
  similarity?: number
}

/** SQLite `YYYY-MM-DD HH:MM:SS` (UTC) and ISO strings both become epoch ms. */
function parseEngineTime(value: string | undefined): number {
  if (!value)
    return Date.now()
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** The store tools answer with a JSON envelope inside the text content. */
function unwrapContent(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type?: string, text?: string }[] } | undefined)?.content
  const text = content?.find(item => item.type === 'text')?.text
  if (!text)
    return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  }
  catch {
    return {}
  }
}

export interface CastaliaEngineMemory {
  list: () => Promise<CastaliaMemoryEntry[]>
  save: (entry: CastaliaMemoryEntry) => Promise<void>
  forget: (entry: { id?: string, name?: string, persona?: string }) => Promise<boolean>
  /**
   * Renders a context block for one query. The engine abstains with empty text,
   * so the caller appends the block without a relevance check of its own.
   */
  recall: (query: string) => Promise<CastaliaRecalledMemory>
  /**
   * Ranked lookup over the bank for one query (the engine's `memory_search`).
   *
   * Unlike `recall` there is no similarity gate and no injection block: the result is
   * a ranked list, and an empty list means nothing matched. Optional so a host whose
   * backend cannot search simply exposes no search tool result.
   */
  search?: (query: string, topK?: number) => Promise<CastaliaSearchedMemory[]>
  /** Structured facts for the same query; `[]` when the backend has none or they are far off. */
  facts?: (query: string, topK?: number) => Promise<CastaliaSearchedFact[]>
  /**
   * Writes one finished turn back into the bank (conversation_log). Optional: the
   * stdio transport predates it, so a host without it simply does not ingest.
   */
  ingest?: (turn: CastaliaIngestTurn) => Promise<CastaliaIngestResult>
  /** 进程内维护：抽取 + 整合 + digest。没有实现的后端就不跑（返回 ok:false）。 */
  maintain?: (options?: { limit?: number }) => Promise<CastaliaMaintainReport>
  /** 引擎当前的 psyche 状态（情绪坐标 + 慢层心境 + band）。没有实现的后端返回 null。 */
  psycheState?: (options?: { characterId?: string }) => Promise<import('../../../shared/eventa/castalia-memory').CastaliaPsycheSnapshot | null>
  /** Mirrors the mind's energy into the engine's own prompt state. */
  setSelfEnergy?: (value: number) => Promise<void>
  /** Run one bounded self-cycle on the same engine/bank. */
  selfCycle?: (options?: { project?: string, characterId?: string, limit?: number, hoursBack?: number, minIntervalHours?: number }) => Promise<CastaliaSelfCycleReport>
  close: () => Promise<void>
}

/** One finished turn: what the user said and what the model finally answered. */
export interface CastaliaIngestTurn {
  user: string
  assistant: string
  sessionId?: string
}

export interface CastaliaIngestResult {
  ok: boolean
  id?: string
  mode?: string
  error?: string
}

export interface CastaliaSelfCycleReport {
  ok: boolean
  skipped: boolean
  reason?: string
  diaryId?: string
  evidenceIds: string[]
  project: string
}

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

/** Creates the memory port backed by one engine process (connected on first use). */
export function createCastaliaEngineMemory(options: CastaliaEngineOptions): CastaliaEngineMemory {
  let clientPromise: Promise<Client> | undefined
  let closing = false

  function connect() {
    if (!clientPromise) {
      const transport = new StdioClientTransport({
        command: options.nodeBinary,
        args: [options.engineEntry],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
          // An Electron binary would need ELECTRON_RUN_AS_NODE and the wrong native ABI; the
          // engine's better-sqlite3 is built for the tray's Node, so never fall back to execPath.
          ELECTRON_RUN_AS_NODE: '',
          MEMORY_DB_DIR: options.bankDir,
          MEMORY_CONFIG: join(options.bankDir, 'config.json'),
          CASTALIA_PROJECT: options.project,
          CHAR_ID: options.character,
          MCP_TOOLS: 'store,self_cycle,memory_recent,memory_search',
          HEALTH_PORT: '0',
          CONSOLIDATE_AUTO_ON_START: '0',
        },
        stderr: 'inherit',
      })
      const client = new Client({ name: 'airi-memory', version: '1.28.0' })
      clientPromise = client.connect(transport).then(() => client)
    }
    return clientPromise
  }

  async function call(tool: string, args: Record<string, unknown>) {
    const client = await connect()
    return unwrapContent(await client.callTool({ name: tool, arguments: args }))
  }

  return {
    async list() {
      if (closing)
        return []
      const envelope = await call('memory_store_list', {
        project: options.project,
        allCharacters: true,
        source: 'airi',
        limit: 2000,
      })
      if (envelope.ok !== true)
        throw new Error(`castalia engine list failed: ${JSON.stringify(envelope.error ?? envelope)}`)
      const rows = (envelope.results ?? []) as EngineStoreRow[]
      return rows
        .filter(row => typeof row.name === 'string' && row.name.length > 0)
        .map(row => ({
          name: String(row.name),
          description: row.description ?? '',
          body: row.body ?? '',
          ...(row.general ? {} : { persona: row.characterId || undefined }),
          updatedAt: parseEngineTime(row.updatedAt ?? row.createdAt),
        } as CastaliaMemoryEntry))
    },

    async save(entry) {
      if (closing)
        return
      const envelope = await call('memory_store_save', {
        project: options.project,
        name: entry.name,
        description: entry.description,
        body: entry.body,
        ...(entry.persona ? { characterId: entry.persona } : { general: true }),
      })
      if (envelope.ok !== true)
        throw new Error(`castalia engine save failed: ${JSON.stringify(envelope.error ?? envelope)}`)
    },

    async forget(entry) {
      if (closing)
        return false
      const envelope = await call('memory_store_forget', {
        project: options.project,
        name: entry.name,
        ...(entry.persona ? { characterId: entry.persona } : { general: true }),
      })
      return envelope.ok === true && envelope.deleted === true
    },

    async recall(query) {
      if (closing)
        return { text: '', count: 0, topSim: 0, chars: 0 }
      const envelope = await call('memory_recall', { project: options.project, query })
      if (envelope.ok !== true)
        throw new Error(`castalia engine recall failed: ${JSON.stringify(envelope.error ?? envelope)}`)
      return {
        text: typeof envelope.text === 'string' ? envelope.text : '',
        count: typeof envelope.count === 'number' ? envelope.count : 0,
        topSim: typeof envelope.topSim === 'number' ? envelope.topSim : 0,
        chars: typeof envelope.chars === 'number' ? envelope.chars : 0,
      }
    },

    async search(query, topK = 5) {
      if (closing)
        return []
      const envelope = await call('memory_search', { project: options.project, query, topK })
      if (envelope.ok !== true)
        throw new Error(`castalia engine search failed: ${JSON.stringify(envelope.error ?? envelope)}`)
      return ((envelope.results ?? []) as EngineSearchRow[])
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

    async facts(query, topK = 3) {
      if (closing)
        return []
      const envelope = await call('fact_search', { project: options.project, query, topK })
      if (envelope.ok !== true)
        throw new Error(`castalia engine fact search failed: ${JSON.stringify(envelope.error ?? envelope)}`)
      return ((envelope.results ?? []) as EngineFactRow[])
        .filter(row => typeof row.object === 'string' && row.object.trim().length > 0)
        .map(row => ({
          subject: String(row.subject ?? ''),
          predicate: String(row.predicate ?? ''),
          object: String(row.object ?? ''),
          confidence: typeof row.confidence === 'number' ? row.confidence : 0,
          ...(typeof row.similarity === 'number' ? { similarity: row.similarity } : {}),
        }))
    },

    async selfCycle(input = {}) {
      if (closing)
        return { ok: false, skipped: true, reason: 'closing', evidenceIds: [], project: input.project ?? options.project }
      const envelope = await call('self_cycle', {
        project: input.project ?? options.project,
        characterId: input.characterId ?? options.character,
        limit: input.limit,
        hoursBack: input.hoursBack,
        minIntervalHours: input.minIntervalHours,
      })
      // 这一轮写的日记正文要带回来：AIRI 的「无聊时思考」把它当成一条内部念头，
      // 否则调用方只知道「写了一篇日记」，说不出想了什么。
      // 日记正文只能用 memory_recent 拿：memory_get 按 agent 的 memType 目录找，
      // 找不到写在 project 目录里的日记（实测 NOT_FOUND），而 memory_recent 能读到。
      let diaryText: string | undefined
      if (envelope.ok === true && typeof envelope.diaryId === 'string') {
        try {
          const recent = await call('memory_recent', {
            project: input.project ?? options.project,
            limit: 5,
            hoursBack: 2,
          })
          const rows = Array.isArray((recent as any)?.results) ? (recent as any).results : []
          const hit = rows.find((row: any) => row?.id === envelope.diaryId)
            ?? rows.find((row: any) => typeof row?.text === 'string' && row.text.trim().startsWith('#'))
          if (typeof hit?.text === 'string' && hit.text.trim())
            diaryText = hit.text
        }
        catch {
          // 拿不到正文不影响自循环本身的结果。
        }
      }
      return {
        ok: envelope.ok === true,
        skipped: envelope.skipped === true,
        reason: typeof envelope.reason === 'string' ? envelope.reason : undefined,
        diaryId: typeof envelope.diaryId === 'string' ? envelope.diaryId : undefined,
        diaryText,
        evidenceIds: Array.isArray(envelope.evidenceIds) ? envelope.evidenceIds.map(String) : [],
        project: typeof envelope.project === 'string' ? envelope.project : options.project,
      }
    },
    async close() {
      closing = true
      const client = await clientPromise?.catch(() => undefined)
      clientPromise = undefined
      await client?.close().catch(() => {})
    },
  }
}
