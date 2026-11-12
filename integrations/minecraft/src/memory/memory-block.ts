import type { GameMemoryHit } from './game-memory'

/** One line per hit: kind tag first, then the row's own heading, trimmed to one line. */
const LINE_CHARS = 220
const MAX_LINES = 12

function kindOf(hit: GameMemoryHit): string {
  return hit.category?.replace(/^mc:/, '') ?? hit.memType ?? 'memory'
}

/** Collapses the stored Markdown into one readable line. */
export function hitLine(hit: GameMemoryHit): string {
  const text = hit.text.replace(/\s+/g, ' ').trim()
  const line = `- [${kindOf(hit)}] ${text}`
  return line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line
}

/**
 * The `[MEMORY]` block the bot reads before it plans.
 *
 * Use when:
 * - A session starts, or a turn needs the game memory area in front of it.
 *
 * Why a block and not a tool result: recall that only exists behind a tool call is recall
 * the model never asks for. It reads this every turn, so the block must stay small —
 * a dozen one-line rows and a pointer to `recallMemory` for detail.
 */
export function buildMemoryBlock(hits: readonly GameMemoryHit[], options: { world?: string, query?: string } = {}): string {
  const rows = hits.filter(hit => hit.text.trim()).slice(0, MAX_LINES)
  if (!rows.length)
    return ''
  const head = options.world ? `[MEMORY] 游戏记忆 · ${options.world}` : '[MEMORY] 游戏记忆'
  const body = rows.map(hitLine)
  const tail = options.query
    ? `（本块由查询「${options.query}」召回；更多细节用 recallMemory 再查，写入用 remember）`
    : '（更多细节用 recallMemory 查；新的发现、地点、计划用 remember 写入）'
  return [head, ...body, tail].join('\n')
}
