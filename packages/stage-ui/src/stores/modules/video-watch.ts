import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

/**
 * The videos she means to watch, and what she made of the ones she did.
 *
 * The queue is what turns "she can watch" into "she watches when she wants to": something puts a
 * clip here (a tool call, a link from the owner), and the autonomy ticker may pick one up when the
 * policy says the moment is hers. Watched items keep her digest, so she can bring it up later
 * with timecodes instead of a vague "我好像看过".
 */
export interface VideoWatchItem {
  id: string
  /** Bilibili id or link, a direct URL, or an absolute path. */
  source: string
  /** Platform title, once a probe has run. */
  title?: string
  /** Why she queued it, in her own words. */
  why: string
  addedAt: number
  state: 'pending' | 'watched' | 'skipped'
  /** What she understood: the digest she wrote after watching, with timecodes. */
  note?: string
  watchedAt?: number
}

/** A queue longer than this is hoarding, not curiosity. */
const MAX_PENDING = 20
/** How many watched items keep their note for a recall. */
const KEEP_WATCHED = 30

function normalizeSource(source: string): string {
  return source.trim()
}

function localDay(now: number): string {
  return new Date(now).toLocaleDateString('sv-SE')
}

function newId(): string {
  return `v${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}

export const useVideoWatchStore = defineStore('video-watch', () => {
  const items = useLocalStorageManualReset<VideoWatchItem[]>('video-watch/queue', [])

  /** Oldest first: the item that waited longest is the one most likely to be watched. */
  const pending = computed(() => items.value
    .filter(item => item.state === 'pending')
    .sort((a, b) => a.addedAt - b.addedAt))

  const watched = computed(() => items.value
    .filter(item => item.state === 'watched' && item.note)
    .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0)))

  /**
   * What she watched, grouped by local day (`YYYY-MM-DD`).
   *
   * The diary page joins on this instead of copying a watched clip into the thought stream: her
   * notes and her viewing stay two datasets, and a day is assembled at read time.
   */
  const watchedByDay = computed<Record<string, VideoWatchItem[]>>(() => {
    const days: Record<string, VideoWatchItem[]> = {}
    for (const item of watched.value) {
      if (!item.watchedAt)
        continue
      const day = localDay(item.watchedAt)
      ;(days[day] ??= []).push(item)
    }
    return days
  })

  const lastWatchedAt = computed(() => items.value
    .filter(item => item.state === 'watched' && typeof item.watchedAt === 'number')
    .reduce<number | null>((latest, item) => Math.max(latest ?? 0, item.watchedAt!), null))

  /** Adds a clip. A source already in the queue is not added twice; the older entry keeps its place. */
  function enqueue(input: { source: string, why: string, title?: string }): VideoWatchItem | undefined {
    const source = normalizeSource(input.source)
    if (!source)
      return undefined

    const existing = items.value.find(item => item.state === 'pending' && normalizeSource(item.source) === source)
    if (existing)
      return existing

    const item: VideoWatchItem = {
      id: newId(),
      source,
      why: input.why.trim(),
      addedAt: Date.now(),
      state: 'pending',
      ...(input.title ? { title: input.title } : {}),
    }

    // Hoarding protection: the oldest pending item gives way to the new one.
    const next = [...items.value, item]
    const pendingIds = next.filter(entry => entry.state === 'pending').map(entry => entry.id)
    const overflow = pendingIds.length - MAX_PENDING
    const trimmed = overflow > 0 ? next.filter(entry => !pendingIds.slice(0, overflow).includes(entry.id)) : next
    items.value = trimWatched(trimmed)
    return item
  }

  function trimWatched(list: VideoWatchItem[]): VideoWatchItem[] {
    const watchedItems = list.filter(entry => entry.state !== 'pending')
    if (watchedItems.length <= KEEP_WATCHED)
      return list
    const dropIds = new Set(watchedItems
      .sort((a, b) => (b.watchedAt ?? b.addedAt) - (a.watchedAt ?? a.addedAt))
      .slice(KEEP_WATCHED)
      .map(entry => entry.id))
    return list.filter(entry => !dropIds.has(entry.id))
  }

  function markWatched(id: string, note: string) {
    items.value = trimWatched(items.value.map((item) => {
      if (item.id !== id)
        return item
      return { ...item, state: 'watched' as const, note: note.trim(), watchedAt: Date.now() }
    }))
  }

  function skip(id: string) {
    items.value = items.value.map(item => item.id === id ? { ...item, state: 'skipped' as const } : item)
  }

  function remove(id: string) {
    items.value = items.value.filter(item => item.id !== id)
  }

  /** How many she watched in the local day of `now`. */
  function watchedToday(now: number = Date.now()): number {
    const day = localDay(now)
    return items.value.filter(item => item.state === 'watched' && item.watchedAt && localDay(item.watchedAt) === day).length
  }

  /** Milliseconds since the oldest pending item was queued, or 0 when the queue is empty. */
  function oldestPendingAgeMs(now: number = Date.now()): number {
    const oldest = pending.value[0]
    return oldest ? Math.max(0, now - oldest.addedAt) : 0
  }

  /** The notes of what she watched, newest first, as the recall tool answers them. */
  function recall(limit = 5): string {
    const recent = watched.value.slice(0, Math.max(1, limit))
    if (recent.length === 0)
      return 'You have not watched anything on your own yet.'
    return recent.map((item) => {
      const when = item.watchedAt ? new Date(item.watchedAt).toLocaleString('sv-SE') : 'earlier'
      return `${when} — ${item.title ?? item.source}\nwhy you queued it: ${item.why || '—'}\n${item.note}`
    }).join('\n\n')
  }

  function resetState() {
    items.reset()
  }

  return {
    items,
    pending,
    watched,
    watchedByDay,
    lastWatchedAt,
    enqueue,
    markWatched,
    skip,
    remove,
    watchedToday,
    oldestPendingAgeMs,
    recall,
    resetState,
  }
})
