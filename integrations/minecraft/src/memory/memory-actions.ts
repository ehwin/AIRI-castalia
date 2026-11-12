import type { Action } from '../libs/mineflayer'
import type { MemoryMcpFactory } from './game-memory'
import type { MemoryKind } from './kinds'

import { z } from 'zod'

import { config } from '../composables/config'
import { getGameMemory } from './game-memory'
import { MEMORY_KINDS } from './kinds'
import { buildMemoryBlock } from './memory-block'

const KIND_VALUES = Object.keys(MEMORY_KINDS) as [MemoryKind, ...MemoryKind[]]

/** Tags every row shares, so one world's rows can be separated from another's. */
export function memoryTags(now = new Date()): string[] {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return ['mc', `server:${config.bot.host}_${config.bot.port}`, `day:${day}`]
}

function memoryOrNull() {
  try {
    return getGameMemory()
  }
  catch {
    return null
  }
}

/**
 * The two tools that turn the game memory area into something the bot can use.
 *
 * Use when:
 * - The planner must look something up (`recallMemory`) or keep something (`remember`).
 *
 * Expects:
 * - `configureGameMemory` ran at startup. Without it both tools answer "not configured"
 *   instead of throwing, so a memory-less run still plays.
 *
 * Why tools and not sandbox globals: the tool list is advertised to the model with its
 * schema on every turn, and a tool call is visible in the log. A global would be one more
 * name the model has to remember with nothing to check it against.
 */
export const memoryActions: Action[] = [
  {
    name: 'remember',
    description: [
      'Save one durable fact about this world into the game memory area, so a later session still knows it.',
      'Use it for: a place and its integer coordinates, a build and its materials, a plan the master gave, a death or a discovery worth keeping.',
      'One fact per call. First line is a stable heading such as "# 地点: 主屋"; keep numbers, names and times verbatim.',
    ].join(' '),
    execution: 'sync',
    readonly: true,
    schema: z.object({
      kind: z.enum(KIND_VALUES).describe('Where the fact belongs: world | place | build | plan | event | relation | diary'),
      text: z.string().min(1).describe('The fact. Markdown is fine. Coordinates as integers, no rounding.'),
      importance: z.number().min(0).max(1).optional().describe('0-1, default 0.5. Use 0.8+ for the master\'s base, promises and anything a future session must not lose.'),
    }),
    perform: () => async (kind: MemoryKind, text: string, importance?: number) => {
      const memory = memoryOrNull()
      if (!memory)
        return 'memory not configured; nothing was saved'
      const result = await memory.remember({ kind, text, importance, tags: memoryTags() })
      return result.ok
        ? `remembered as ${kind}${result.id ? ` (id ${result.id.slice(0, 8)})` : ''}`
        : `memory write failed: ${result.error ?? 'unknown error'}`
    },
  },
  {
    name: 'recallMemory',
    description: [
      'Search the game memory area for what earlier sessions knew: a base, a chest, a plan, a player, what happened here before.',
      'Use it before long tasks, before walking to a place you think you know, and when the master refers to something from a past session.',
    ].join(' '),
    execution: 'sync',
    readonly: true,
    schema: z.object({
      query: z.string().min(1).describe('What to look for, in words. Chinese or English.'),
      top_k: z.number().int().min(1).max(12).optional().describe('How many rows, default 5.'),
    }),
    perform: () => async (query: string, topK?: number) => {
      const memory = memoryOrNull()
      if (!memory)
        return 'memory not configured; no recall available'
      const hits = await memory.search(query, topK ?? 5)
      if (!hits.length)
        return `no memory matched "${query}"`
      return buildMemoryBlock(hits, { query, world: `${config.bot.host}:${config.bot.port}` })
    },
  },
]

/** Builds the client from the runtime config. Called once at startup, before any bot spawns. */
export function configureGameMemory(options: {
  url: string
  enabled?: boolean
  project?: string
  /** Test seam: replaces the SDK transport. */
  factory?: MemoryMcpFactory
}) {
  return getGameMemory({
    url: options.url,
    enabled: options.enabled ?? true,
    ...(options.project ? { project: options.project } : {}),
    ...(options.factory ? { factory: options.factory } : {}),
  })
}
