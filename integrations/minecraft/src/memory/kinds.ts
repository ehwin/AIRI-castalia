/**
 * What a Minecraft memory is about.
 *
 * Use when:
 * - The bot decides where one observation belongs in the game memory area.
 *
 * Why a closed list: the recall prompt prints the kind per line, and a free-form kind
 * drifts after a few sessions ("base" / "home" / "基地"), which makes the area useless
 * to grep.
 */
export type MemoryKind = 'world' | 'place' | 'build' | 'plan' | 'event' | 'relation' | 'diary'

export interface MemoryKindTarget {
  /** Partition file the engine writes into. Diary is `general`: the MCP schema rejects memType=diary. */
  memType: 'project' | 'general'
  category: string
  label: string
}

/**
 * Where each kind lands.
 *
 * Why diary is `general` + `mc:diary`: the engine's MCP `memory_save` accepts only
 * user/feedback/project/reference/general, so a `diary` memType is refused before it
 * reaches the store. The category carries the meaning instead, and the row keeps the
 * `# diary-YYYY-MM-DD` header so a diary read can still find it.
 */
export const MEMORY_KINDS: Record<MemoryKind, MemoryKindTarget> = {
  world: { memType: 'project', category: 'mc:world', label: '世界' },
  place: { memType: 'project', category: 'mc:place', label: '地点' },
  build: { memType: 'project', category: 'mc:build', label: '造物' },
  plan: { memType: 'project', category: 'mc:plan', label: '计划' },
  event: { memType: 'general', category: 'mc:event', label: '事件' },
  relation: { memType: 'project', category: 'mc:relation', label: '人物' },
  diary: { memType: 'general', category: 'mc:diary', label: '日记' },
}

export function isMemoryKind(value: string): value is MemoryKind {
  return Object.hasOwn(MEMORY_KINDS, value)
}
