import type { Thought } from '@proj-airi/core-agent'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { distillDay } from '@proj-airi/core-agent'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'
import { useMemoryStore } from '../memory'

/** One day of the diary. */
export interface DiaryDay {
  /** `YYYY-MM-DD` in local time. */
  date: string
  thoughts: Thought[]
  /** How many of them she never said out loud. */
  privateCount: number
}

/** The persona a distilled day starts under before it becomes general. */
const DISTILL_PERSONA = '__diary__'

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
  const distilledDays = useLocalStorageManualReset<string[]>('diary/distilled', [])
  /** The last day that became a memory, so the page can confirm it. */
  const lastDistilled = computed(() => distilledDays.value.at(-1))

  function hasDistilled(date: string) {
    return distilledDays.value.includes(date)
  }

  const memory = useMemoryStore()

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
      thoughts.value = await innerThoughtsRepo.readAll(limit)
      loadedAt.value = Date.now()
    }
    finally {
      loading.value = false
    }
  }

  /**
   * Turns one day into a single general memory.
   *
   * The raw lines stay in the diary. Only the distilled entry reaches long-term
   * memory, so a day costs one index line instead of a transcript.
   */
  function distill(date: string) {
    const day = byDay.value.find(item => item.date === date)
    if (!day)
      return undefined

    const entry = distillDay(day.thoughts, { date })
    if (!entry)
      return undefined

    const stored = memory.write(entry, DISTILL_PERSONA)
    if (!stored)
      return undefined

    memory.makeGeneral({ name: stored.name, persona: DISTILL_PERSONA })
    if (!hasDistilled(date))
      distilledDays.value = [...distilledDays.value, date]
    return entry
  }

  function resetState() {
    reveal.reset()
    distilledDays.reset()
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
