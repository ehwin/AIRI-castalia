/**
 * One owner per mind state.
 *
 * The mind store is created per renderer. With two windows open, both would
 * advance fatigue, both would write the same key, and both would push energy
 * into the engine. The real fix is a main-process runtime; until then this
 * lease keeps exactly one window ticking.
 *
 * It is a lease, not a lock: the owner renews it on every tick, and a window
 * that finds a stale lease takes over. Taking over is only safe together with
 * a reload of the persisted state, otherwise the new owner would apply the
 * whole gap on top of a snapshot it never saw advance.
 */

export interface MindLease {
  id: string
  at: number
}

interface LeaseStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readLease(storage: LeaseStorage | undefined, key: string): MindLease | undefined {
  try {
    const raw = storage?.getItem(key)
    if (!raw)
      return undefined
    const parsed = JSON.parse(raw)
    if (typeof parsed?.id !== 'string' || !Number.isFinite(parsed?.at))
      return undefined
    return parsed as MindLease
  }
  catch {
    return undefined
  }
}

/**
 * Writes our lease if nobody else holds a fresh one, then reads it back.
 *
 * The read-back matters: two windows can both see "no lease" and both write.
 * Whoever wrote last wins, so the loser learns it lost instead of believing it
 * claimed the mind.
 */
export function claimLease(
  storage: LeaseStorage | undefined,
  key: string,
  id: string,
  now: number,
  ttlMs: number,
): boolean {
  try {
    if (!storage)
      return true
    const current = readLease(storage, key)
    if (current && current.id !== id && now - current.at < ttlMs)
      return false
    storage.setItem(key, JSON.stringify({ id, at: now }))
    return readLease(storage, key)?.id === id
  }
  catch {
    // Storage can be unavailable (privacy mode, quota). One window that cannot
    // persist is still a working mind; do not freeze it.
    return true
  }
}

/** Renews our lease; returns false when another window holds it. */
export function ownsLease(
  storage: LeaseStorage | undefined,
  key: string,
  id: string,
  now: number,
  ttlMs: number,
): boolean {
  const current = readLease(storage, key)
  if (current?.id === id) {
    try {
      storage?.setItem(key, JSON.stringify({ id, at: now }))
    }
    catch { /* best effort */ }
    return true
  }
  return claimLease(storage, key, id, now, ttlMs)
}
