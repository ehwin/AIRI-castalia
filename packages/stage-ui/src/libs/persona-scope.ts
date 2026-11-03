/**
 * Per-character storage.
 *
 * A card is a character, and everything a character feels, remembers, or says on her own belongs to her alone:
 * drives, the diary, the notice pace, the topic that was already used. A single shared key let one character's mood
 * and pace leak into another, which is exactly what a companion must never do.
 *
 * Keys are `base::persona`. A key without a persona stays global on purpose: settings, providers, and the owner's
 * own preferences are not a character's property.
 */

const SEPARATOR = '::'

/** Storage key of one character's slice of `base`. */
export function scopedKey(base: string, personaId: string | undefined | null): string {
  return personaId ? `${base}${SEPARATOR}${personaId}` : base
}

/**
 * Reads one character's slice, taking over the old shared value the first time.
 *
 * Before this existed, the diary and the notice pace lived under one key for every character. The first character
 * that loads keeps that history; a later one starts empty instead of inheriting a stranger's day.
 */
export function readScoped<T>(base: string, personaId: string, fallback: T, storage: Storage | undefined = globalThis.localStorage): T {
  if (!storage)
    return fallback
  const scoped = scopedKey(base, personaId)
  try {
    const own = storage.getItem(scoped)
    if (own !== null)
      return JSON.parse(own) as T
    // `base` itself is the pre-scope shared value. Only one character may claim it.
    const claimKey = `${base}${SEPARATOR}claimed-by`
    const claimedBy = storage.getItem(claimKey)
    const legacy = storage.getItem(base)
    if (legacy !== null && (!claimedBy || claimedBy === personaId)) {
      storage.setItem(claimKey, personaId)
      storage.setItem(scoped, legacy)
      return JSON.parse(legacy) as T
    }
  }
  catch { /* 坏数据按没有处理，下一次写入会覆盖 */ }
  return fallback
}

/** Writes one character's slice. */
export function writeScoped(base: string, personaId: string, value: unknown, storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage)
    return
  try {
    storage.setItem(scopedKey(base, personaId), JSON.stringify(value))
  }
  catch { /* 存不下就退化成内存态 */ }
}

/** Removes one character's slice, used by tests and by a character reset. */
export function removeScoped(base: string, personaId: string, storage: Storage | undefined = globalThis.localStorage): void {
  storage?.removeItem(scopedKey(base, personaId))
}
