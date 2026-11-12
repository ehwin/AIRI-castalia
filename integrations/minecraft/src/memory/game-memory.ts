import type { Logger } from '../utils/logger'
import type { MemoryKind } from './kinds'

import { errorMessageFrom } from '@moeru/std'
import { Mutex } from 'async-mutex'

import { useLogger } from '../utils/logger'
import { MEMORY_KINDS } from './kinds'

/** One row the game memory area returned. */
export interface GameMemoryHit {
  id?: string
  text: string
  category?: string
  memType?: string
  score?: number
  createdAt?: string
}

export interface GameMemoryRememberInput {
  kind: MemoryKind
  text: string
  /** Defaults to 0.5. Raise it for something the bot must never forget (master's base, promises). */
  importance?: number
  tags?: string[]
}

export interface GameMemoryRememberResult {
  ok: boolean
  id?: string
  error?: string
  /** Rows holding the same text that the engine wrote twice and this call removed. */
  collapsed?: number
}

/** The two calls this client needs from an MCP client. Structural, so a test can fake it. */
export interface MemoryMcpClient {
  callTool: (
    params: { name: string, arguments: Record<string, unknown> },
    schema?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<{ content?: Array<{ type?: string, text?: string }> }>
  close: () => Promise<void>
}

export type MemoryMcpFactory = () => Promise<MemoryMcpClient>

export interface GameMemoryOptions {
  /** Streamable-HTTP MCP endpoint of the game bridge, for example http://127.0.0.1:3320/mcp. */
  url: string
  /** Project namespace the bridge points at. The bot must not write into the persona project. */
  project?: string
  enabled?: boolean
  timeoutMs?: number
  /** Injectable for tests; the default builds the SDK client over `url`. */
  factory?: MemoryMcpFactory
  logger?: Pick<Logger, 'log' | 'error'> | null
}

const DEFAULT_PROJECT = 'minecraft'
const DEFAULT_TIMEOUT_MS = 8_000
const FAILURE_COOLDOWN_MS = 30_000
/** How many recall rows one write may inspect while looking for its own duplicates. */
const VERIFY_CANDIDATES = 4

/** Builds the SDK client lazily, so a bot without a memory bridge never imports the SDK. */
async function createSdkClient(url: string): Promise<MemoryMcpClient> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ])
  const client = new Client({ name: 'minecraft-bot', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url))
  await client.connect(transport)
  // The SDK's `callTool` returns a wider result type than the two fields this client reads.
  // Narrowing at this one boundary keeps the rest of the file free of MCP types.
  return client as unknown as MemoryMcpClient
}

/** Reads the JSON payload the engine puts in the first text content block. */
function parsePayload(result: { content?: Array<{ type?: string, text?: string }> }): unknown {
  const text = (result.content ?? [])
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join('')
  if (!text.trim())
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/** Finds the first array of rows in a payload, whatever name the tool used for it. */
function extractRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload))
    return payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  if (!payload || typeof payload !== 'object')
    return []
  const record: Record<string, unknown> = { ...payload }
  for (const key of ['results', 'memories', 'items', 'rows', 'entries']) {
    const value = record[key]
    if (Array.isArray(value))
      return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  }
  return []
}

function toHit(row: Record<string, unknown>): GameMemoryHit {
  const text = typeof row.text === 'string'
    ? row.text
    : typeof row.summary === 'string' ? row.summary : ''
  return {
    ...(typeof row.id === 'string' ? { id: row.id } : {}),
    text,
    ...(typeof row.category === 'string' ? { category: row.category } : {}),
    ...(typeof row.memType === 'string' ? { memType: row.memType } : {}),
    ...(typeof row.score === 'number' ? { score: row.score } : {}),
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
  }
}

/** The comparison the engine uses: case and whitespace do not make two rows different. */
function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The Minecraft bot's view of the game memory area.
 *
 * Use when:
 * - The bot starts a session, plans an action, or learns something durable.
 *
 * Expects:
 * - A Castalia bridge on `url` serving the `minecraft` project (bank airi).
 *
 * Returns:
 * - `remember`, `search`, `recent`, and a health flag. Every call answers instead of
 *   throwing: a dead memory bridge must not stop the bot from playing.
 *
 * Why a cooldown: without it, a stopped bridge turns every turn into an 8 s timeout.
 * One failure silences the client for 30 s, and the next success clears it.
 *
 * Why a write mutex: the engine's exact-text dedupe reads before it inserts. Three saves of
 * one text fired together produced three rows (measured 2026-11-06: 3 parallel calls gave 3
 * rows, the same 3 calls in sequence gave 1). Queueing writes in this process closes that
 * window, and `collapseDuplicates` repairs rows any other writer created.
 */
export class GameMemory {
  private readonly url: string
  private readonly project: string
  private readonly enabled: boolean
  private readonly timeoutMs: number
  private readonly factory: MemoryMcpFactory
  private readonly logger: Pick<Logger, 'log' | 'error'> | null
  /** One writer at a time. See the class note: the engine dedupe is read-then-insert. */
  private readonly writeMutex = new Mutex()
  private client: MemoryMcpClient | null = null
  private connecting: Promise<MemoryMcpClient | null> | null = null
  private cooldownUntil = 0
  private lastError = ''

  constructor(options: GameMemoryOptions) {
    this.url = options.url
    this.project = options.project ?? DEFAULT_PROJECT
    this.enabled = options.enabled ?? true
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.factory = options.factory ?? (() => createSdkClient(this.url))
    this.logger = 'logger' in options ? options.logger ?? null : useLogger()
  }

  /** Whether the client may call out right now. */
  get available(): boolean {
    return this.enabled && Date.now() >= this.cooldownUntil
  }

  get lastErrorMessage(): string {
    return this.lastError
  }

  private markFailure(error: unknown) {
    this.lastError = errorMessageFrom(error) ?? 'unknown memory error'
    this.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
    this.client = null
    this.logger?.error(`Game memory unavailable: ${this.lastError}`)
  }

  private async ensureClient(): Promise<MemoryMcpClient | null> {
    if (!this.available)
      return null
    if (this.client)
      return this.client
    if (!this.connecting) {
      this.connecting = this.factory()
        .then((client) => {
          this.client = client
          this.logger?.log(`Game memory connected: ${this.url}`)
          return client
        })
        .catch((error) => {
          this.markFailure(error)
          return null
        })
        .finally(() => {
          this.connecting = null
        })
    }
    return this.connecting
  }

  /** One tool call, parsed. `null` means the call did not happen or failed. */
  private async call(name: string, args: Record<string, unknown>): Promise<unknown | null> {
    const client = await this.ensureClient()
    if (!client)
      return null
    try {
      // AbortSignal.timeout is the runtime's own deadline: it aborts the request instead of
      // leaving an orphan promise behind, which the hand-rolled timer did.
      const result = await client.callTool(
        { name, arguments: { ...args, project: this.project } },
        undefined,
        { signal: AbortSignal.timeout(this.timeoutMs) },
      )
      const payload = parsePayload(result)
      if (payload && typeof payload === 'object' && (payload as { ok?: boolean }).ok === false) {
        const error = String((payload as { error?: unknown }).error ?? 'memory tool refused the call')
        this.markFailure(new Error(error))
        return null
      }
      this.cooldownUntil = 0
      return payload
    }
    catch (error) {
      this.markFailure(error)
      return null
    }
  }

  /** One row, with its full text. `null` when the bridge cannot answer. */
  async get(id: string): Promise<GameMemoryHit | null> {
    const payload = await this.call('memory_get', { id })
    if (!payload || typeof payload !== 'object')
      return null
    const record = payload as Record<string, unknown>
    const memory = (record.memory ?? record.result ?? record) as Record<string, unknown>
    const hit = toHit(memory)
    return hit.text.trim() ? hit : null
  }

  /** Soft-deletes one row. `true` when the engine confirms it is gone. */
  async remove(id: string): Promise<boolean> {
    const payload = await this.call('memory_delete', { id })
    return Boolean(payload && typeof payload === 'object' && (payload as { deleted?: unknown }).deleted === true)
  }

  /**
   * Removes other active rows that hold exactly this text, keeping `keepId`.
   *
   * Why: the engine writes a duplicate when two saves of one text overlap. The mutex stops
   * that inside this process. This pass also covers rows another writer created, and it is
   * the only repair the MCP surface offers from outside the engine.
   */
  private async collapseDuplicates(text: string, keepId: string): Promise<number> {
    const heading = text.split('\n')[0].trim().slice(0, 80)
    if (!heading)
      return 0
    // Ids only: a search row carries a truncated text, so the comparison happens on
    // `memory_get`, one row at a time.
    const payload = await this.call('memory_search', { query: heading, topK: VERIFY_CANDIDATES + 2 })
    const candidates = extractRows(payload)
      .map(row => row.id)
      .filter((id): id is string => typeof id === 'string' && id !== keepId)
      .slice(0, VERIFY_CANDIDATES)
    let removed = 0
    for (const id of candidates) {
      const row = await this.get(id)
      if (!row || normalizeText(row.text) !== normalizeText(text))
        continue
      if (await this.remove(id))
        removed += 1
    }
    return removed
  }

  /**
   * Stores one observation, one write at a time, then removes duplicates of it. Never throws.
   *
   * Why the mutex is the default: the engine dedupes by reading before it inserts, so
   * overlapping saves of one text all miss each other. Queueing writes here closes that
   * window without an engine change.
   */
  async remember(input: GameMemoryRememberInput): Promise<GameMemoryRememberResult> {
    const target = MEMORY_KINDS[input.kind]
    const text = input.text.trim()
    if (!target || !text)
      return { ok: false, error: 'invalid memory input' }
    return this.writeMutex.runExclusive(async () => {
      const payload = await this.call('memory_save', {
        text,
        memType: target.memType,
        category: target.category,
        tags: input.tags?.length ? input.tags : ['mc'],
        importance: input.importance ?? 0.5,
        source: 'minecraft-bot',
      })
      if (!payload)
        return { ok: false, error: this.lastError || 'memory bridge unavailable' }
      if (typeof payload !== 'object')
        return { ok: false, error: 'unexpected memory answer' }
      const id = (payload as { id?: unknown }).id
      if (typeof id !== 'string')
        return { ok: true }
      const collapsed = await this.collapseDuplicates(text, id)
      if (collapsed > 0)
        this.logger?.log(`Game memory: collapsed ${collapsed} duplicate row(s) for ${id}`)
      return { ok: true, id, ...(collapsed > 0 ? { collapsed } : {}) }
    })
  }

  /** Ranked recall. An empty array is a real "nothing matched"; a dead bridge is also empty. */
  async search(query: string, topK = 5): Promise<GameMemoryHit[]> {
    const text = query.trim()
    if (!text)
      return []
    const payload = await this.call('memory_search', { query: text, topK })
    return extractRows(payload).map(toHit).filter(hit => hit.text.trim())
  }

  /** The newest rows, for the session-start block. */
  async recent(limit = 10): Promise<GameMemoryHit[]> {
    const payload = await this.call('memory_recent', { limit })
    return extractRows(payload).map(toHit).filter(hit => hit.text.trim())
  }

  /** Drops the transport. The next call reconnects. */
  async close(): Promise<void> {
    const client = this.client
    this.client = null
    if (!client)
      return
    try {
      await client.close()
    }
    catch {
      // A transport that is already gone needs no cleanup.
    }
  }
}

let shared: GameMemory | null = null

/** Process-wide client, built from the runtime config. */
export function getGameMemory(options?: GameMemoryOptions): GameMemory {
  if (!shared) {
    if (!options)
      throw new Error('game memory is not configured yet')
    shared = new GameMemory(options)
  }
  return shared
}

/** Test seam: forgets the shared client. */
export function resetGameMemory(): void {
  shared = null
}
