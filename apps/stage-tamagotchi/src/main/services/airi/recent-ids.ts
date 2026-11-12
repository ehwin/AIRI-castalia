/**
 * The memory ids that were just injected, per character.
 *
 * The list exists so a recall does not fill the block with the same rows for a run of
 * turns. It used to be one list for the whole process: with two cards open, the ids the
 * first card had just seen also suppressed those rows for the second one. Shared
 * (general) memories are visible to both, so the second character lost a memory the
 * first had just read. Recall state belongs to a character the same way the rows do.
 */

/** How many ids one character remembers. Ten turns is enough to stop a repeat, not a ban. */
export const RECENT_ID_LIMIT = 10

/** The placeholder used when no character was named, matching the bank's own fallback. */
const DEFAULT_KEY = 'default'

function keyOf(persona: string | undefined): string {
  return (persona ?? '').trim() || DEFAULT_KEY
}

/** The ids this character was just shown. */
export function recentIdsFor(
  store: ReadonlyMap<string, string[]>,
  persona: string | undefined,
): string[] {
  return store.get(keyOf(persona)) ?? []
}

/**
 * Appends the ids of this recall and returns the new list.
 *
 * Empty and non-string ids are dropped rather than stored: a `undefined` in the list would
 * never match a row, so it would only waste one of the ten slots.
 */
export function pushRecentIds(
  store: Map<string, string[]>,
  persona: string | undefined,
  ids: readonly unknown[],
  limit = RECENT_ID_LIMIT,
): string[] {
  const key = keyOf(persona)
  const fresh = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  const merged = [...(store.get(key) ?? []), ...fresh].slice(-Math.max(1, limit))
  store.set(key, merged)
  return merged
}
