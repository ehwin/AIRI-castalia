import type { CastaliaMemoryEntry } from '@proj-airi/castalia-plugin/memory'

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
  forget: (entry: Pick<CastaliaMemoryEntry, 'name' | 'persona'>) => Promise<boolean>
  close: () => Promise<void>
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
          MCP_TOOLS: 'store',
          HEALTH_PORT: '0',
          CONSOLIDATE_AUTO_ON_START: '0',
        },
        stderr: 'inherit',
      })
      const client = new Client({ name: 'airi-memory', version: '1.26.0' })
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

    async close() {
      closing = true
      const client = await clientPromise?.catch(() => undefined)
      clientPromise = undefined
      await client?.close().catch(() => {})
    },
  }
}
