import type { Thought } from '@proj-airi/core-agent'

import { distillDay } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'
import { useMemoryStore } from '../memory'
import { activeCardIdFromStorage } from './airi-card'

/** One day of the diary. */
export interface DiaryDay {
  /** `YYYY-MM-DD` in local time. */
  date: string
  thoughts: Thought[]
  /** How many of them she never said out loud. */
  privateCount: number
}

/**
 * The diary, read from the same stream the mind writes.
 *
 * This store never writes to the diary. The background lane owns the stream.
 *
 * The full text stays hidden by default: a diary the owner reads every day
 * stops being a diary. What shows by default is what she chose to say, plus
 * counts. `reveal` is the owner's deliberate choice to read the rest.
 */
export const useDiaryStore = defineStore('diary', () => {
  const thoughts = ref<Thought[]>([])
  const loading = ref(false)
  const loadedAt = ref<number>()
  /** Off by default. Turning it on is a deliberate act, not a setting to explore. */
  const reveal = useLocalStorageManualReset<boolean>('diary/reveal', false)
  /**
   * Days already turned into a memory.
   *
   * Persisted: a day that is already remembered must not be offered again after a
   * restart, or the button says "记住这一天" for something the index already holds.
   */
  // Keyed by character: one character's remembered days are not another's. A plain array is the pre-split value.
  const distilledByPersona = useLocalStorageManualReset<Record<string, string[]>>('diary/distilled', {})
  const memory = useMemoryStore()
  /**
   * The character whose diary this is.
   *
   * Not `mind.scope`: the mind has one owner window, and a window that never became the owner kept
   * its scope at the `default` start. The page then listed four legacy thoughts of a card nobody
   * was using, and remembered those days. The chat resolves the same question from the active card,
   * so the diary does too.
   */
  function persona() {
    const card = activeCardIdFromStorage()
    return memory.enabled ? memory.resolvePersona(card) : card
  }

  /** This character's remembered days. The own slice of the per-character map. */
  const distilledDays = computed<string[]>({
    get: () => distilledByPersona.value[persona()] ?? [],
    set: (dates) => {
      distilledByPersona.value = { ...distilledByPersona.value, [persona()]: dates }
    },
  })

  /** The last day that became a memory, so the page can confirm it. */
  const lastDistilled = computed(() => distilledDays.value.at(-1))

  function hasDistilled(date: string) {
    return distilledDays.value.includes(date)
  }

  /** Moves the pre-split array to the character that opens the diary first. */
  function adoptLegacyDays() {
    const saved = distilledByPersona.value as unknown
    if (!Array.isArray(saved))
      return
    distilledByPersona.value = { [persona()]: saved as string[] }
  }

  const byDay = computed<DiaryDay[]>(() => {
    const days = new Map<string, Thought[]>()
    for (const thought of thoughts.value) {
      const date = new Date(thought.at).toLocaleDateString('sv-SE')
      days.set(date, [...(days.get(date) ?? []), thought])
    }
    return [...days]
      .sort((left, right) => right[0].localeCompare(left[0]))
      .map(([date, items]) => ({
        date,
        thoughts: [...items].sort((left, right) => right.at - left.at),
        privateCount: items.filter(item => item.visibility === 'private').length,
      }))
  })

  /** What she chose to say, newest first. Safe to show without `reveal`. */
  const shared = computed(() =>
    thoughts.value.filter(thought => thought.visibility === 'shared').sort((left, right) => right.at - left.at))

  /** How much of the diary she has said out loud. Zero is the normal case. */
  const saidOutLoud = computed(() => {
    if (thoughts.value.length === 0)
      return 0
    return thoughts.value.filter(thought => thought.visibility === 'shared').length / thoughts.value.length
  })

  const total = computed(() => thoughts.value.length)

  async function load(limit = 200) {
    loading.value = true
    try {
      adoptLegacyDays()
      // A thought written before the split has no persona. Adopt it for the card that reads the
      // diary first, the same way `switchCharacter` does, so one character's day never shows up
      // in another's diary.
      const all = await innerThoughtsRepo.readAll(limit)
      const legacy = all.filter(thought => !thought.persona)
      for (const thought of legacy)
        thought.persona = persona()
      if (legacy.length)
        await Promise.all(legacy.map(thought => innerThoughtsRepo.append(thought)))
      thoughts.value = all.filter(thought => thought.persona === persona())
      loadedAt.value = Date.now()
    }
    finally {
      loading.value = false
    }
  }

  /**
   * Turns one day into a single diary row.
   *
   * The raw lines stay in the diary. Only the distilled day reaches memory, and it lands in the
   * diary partition, so the prompt index and an ordinary search never read it.
   */
  async function distill(date: string) {
    const day = byDay.value.find(item => item.date === date)
    if (!day)
      return undefined

    const entry = distillDay(day.thoughts, { date })
    if (!entry)
      return undefined

    // Her day becomes her memory in the diary partition: one row per day, readable only when
    // someone asks the diary. It stays out of the prompt index, the ordinary search and the graph.
    const written = await memory.rememberDay({
      date,
      description: entry.description,
      body: entry.body,
      persona: memory.resolvePersona(persona()),
    })
    // The backend answer is what decides. Marking the day before it lands left "已记住" on a memory
    // the bank rolled back (and never retried).
    if (!written.ok)
      return undefined
    if (!hasDistilled(date))
      distilledDays.value = [...distilledDays.value, date]
    return entry
  }

  function resetState() {
    reveal.reset()
    distilledByPersona.reset()
  }

  return {
    thoughts,
    loading,
    loadedAt,
    reveal,
    lastDistilled,
    hasDistilled,
    byDay,
    shared,
    saidOutLoud,
    total,
    load,
    distill,
    resetState,
  }
})
