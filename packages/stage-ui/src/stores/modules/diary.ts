import type { Thought } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'

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
 * This store never writes. The background lane owns the stream, and the user
 * reads it here. Nothing on this page is spoken to anyone.
 */
export const useDiaryStore = defineStore('diary', () => {
  const thoughts = ref<Thought[]>([])
  const loading = ref(false)
  const loadedAt = ref<number>()

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

  /** How much of the diary she has said out loud. Zero is the normal case. */
  const saidOutLoud = computed(() => {
    if (thoughts.value.length === 0)
      return 0
    return thoughts.value.filter(thought => thought.visibility === 'shared').length / thoughts.value.length
  })

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

  return {
    thoughts,
    loading,
    loadedAt,
    byDay,
    saidOutLoud,
    load,
  }
})
