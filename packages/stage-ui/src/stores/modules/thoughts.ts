import type { MemoryThought } from '../memory'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'
import { useMemoryStore } from '../memory'
import { activeCardIdFromStorage } from './airi-card'

/** How much of the local stream one flush looks at. */
const ARCHIVE_READ_LIMIT = 5000

/** One day of the inner stream, as the archive holds it. */
export interface ThoughtDay {
  /** `YYYY-MM-DD` in local time. */
  date: string
  thoughts: MemoryThought[]
  /** How many of them she never said out loud. */
  privateCount: number
}

/**
 * The thought archive.
 *
 * The mind writes to the renderer's own store; this mirror pushes those lines into the memory bank
 * on a slow timer, into their own file next to the diary. Nothing here is meant to be recalled:
 * the rows carry no vectors, and only this page reads them back.
 *
 * The archive is a mirror, not a source. A flush that fails leaves the cursor where it was, so the
 * next one retries the same lines instead of silently skipping them.
 */
export const useThoughtsStore = defineStore('thoughts', () => {
  const memory = useMemoryStore()
  const thoughts = ref<MemoryThought[]>([])
  const loading = ref(false)
  /** Why the last read failed, so the page can say "could not open" instead of "nothing there". */
  const error = ref('')
  /** Newest `at` already in the bank. 0 means "ask the bank where it stands". */
  let cursor = 0
  let archiving = false
  /** Ids the bank already knows as spoken aloud, so an update is sent once, not every flush. */
  const sharedSynced = new Set<string>()
  let seeded = false

  function persona() {
    const card = activeCardIdFromStorage()
    return memory.enabled ? memory.resolvePersona(card) : card
  }

  const byDay = computed<ThoughtDay[]>(() => {
    const days = new Map<string, MemoryThought[]>()
    for (const thought of thoughts.value) {
      const date = new Date(thought.at).toLocaleDateString('sv-SE')
      days.set(date, [...(days.get(date) ?? []), thought])
    }
    return [...days]
      .sort((left, right) => right[0].localeCompare(left[0]))
      .map(([date, items]) => ({
        date,
        thoughts: [...items].sort((left, right) => right.at - left.at),
        privateCount: items.filter(item => item.visibility !== 'shared').length,
      }))
  })

  const total = computed(() => thoughts.value.length)

  async function load(limit = 6000) {
    loading.value = true
    error.value = ''
    try {
      thoughts.value = await memory.listThoughts({ limit, persona: persona() })
    }
    catch (failure) {
      error.value = String((failure as Error)?.message ?? failure)
      thoughts.value = []
    }
    finally {
      loading.value = false
    }
  }

  /**
   * Pushes the lines the bank does not have yet.
   *
   * The first flush asks the bank for its newest row and continues from there, so a restart does
   * not re-upload a year of thoughts. Rows are keyed by the thought's own id, so a re-send is a
   * replace, not a duplicate.
   */
  async function archive(): Promise<number> {
    if (!memory.enabled || !memory.thoughtsSupported || archiving)
      return 0
    archiving = true
    try {
      if (!cursor || !seeded) {
        try {
          const recent = await memory.listThoughts({ limit: ARCHIVE_READ_LIMIT, persona: persona() })
          cursor = Math.max(cursor, recent[0]?.at ?? 0)
          for (const row of recent) {
            if (row.visibility === 'shared')
              sharedSynced.add(row.id)
          }
          seeded = true
        }
        catch {
          return 0
        }
      }
      const all = await innerThoughtsRepo.readAll(ARCHIVE_READ_LIMIT)
      const fresh = all.filter(thought => thought.at > cursor)
      // 她说出口的那一句会晚于写入才变成 shared：游标不会回头，所以单独补一次，
      // 否则存档里永远停在 private，那一页看不到她自己说出来的话。
      const spoken = all.filter(thought => thought.visibility === 'shared' && !sharedSynced.has(thought.id))
      const byId = new Map<string, typeof all[number]>()
      for (const thought of [...fresh, ...spoken])
        byId.set(thought.id, thought)
      const pending = [...byId.values()].sort((left, right) => left.at - right.at)
      if (!pending.length)
        return 0
      const result = await memory.rememberThoughts(pending.map(thought => ({
        id: thought.id,
        at: thought.at,
        text: thought.text,
        visibility: thought.visibility,
        ...(thought.topic ? { topic: thought.topic } : {}),
        persona: persona(),
      })))
      if (!result.ok)
        return 0
      cursor = Math.max(cursor, pending[pending.length - 1]!.at)
      for (const thought of pending) {
        if (thought.visibility === 'shared')
          sharedSynced.add(thought.id)
      }
      return result.saved ?? pending.length
    }
    finally {
      archiving = false
    }
  }

  function resetState() {
    thoughts.value = []
    error.value = ''
    cursor = 0
    seeded = false
    sharedSynced.clear()
  }

  return {
    thoughts,
    byDay,
    total,
    loading,
    error,
    load,
    archive,
    resetState,
  }
})
