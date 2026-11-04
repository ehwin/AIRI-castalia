import type { AgentStateSnapshot, MoodEvent } from './agent-state'
import type { VADVector } from './emotion'

import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { aggregateMood, currentEnergyFrom } from './agent-state'

/** One psyche snapshot from the engine. `hasEvidence: false` means the engine let the evidence expire. */
interface SyncPsycheInput {
  vad?: VADVector
  mood?: VADVector
  band?: string
  at?: number
  hasEvidence?: boolean
}

interface PersistedAgentState {
  moodHistory: MoodEvent[]
  currentDesire: string | null
  energy: number
  lastUpdated: number
  vad?: VADVector
  moodVad?: VADVector
  band?: string
  vadUpdatedAt?: number
  tsundereLevel?: number
}

/**
 * Built per use, not at module load. A shared object would freeze `lastUpdated`
 * at import time, so a character with no record would decay from import.
 */
function createEmptyState(): PersistedAgentState {
  return {
    moodHistory: [],
    currentDesire: null,
    energy: 100,
    lastUpdated: Date.now(),
  }
}

export const useCastaliaPluginStore = defineStore('castalia-plugin', () => {
  const enabled = useStorage('castalia/enabled', true)
  const states = useStorage<Record<string, PersistedAgentState>>('castalia/agent-states', {})
  const activeCharacterId = ref('default')
  const activeState = computed(() => states.value[activeCharacterId.value] ?? createEmptyState())

  const currentMood = computed(() => {
    return aggregateMood(activeState.value.moodHistory, Date.now())
  })

  const currentEnergy = computed(() => {
    return currentEnergyFrom(activeState.value.energy, activeState.value.lastUpdated, Date.now())
  })

  function setCharacter(characterId: string) {
    activeCharacterId.value = characterId || 'default'
  }

  function snapshotFor(characterId = activeCharacterId.value): AgentStateSnapshot {
    const state = states.value[characterId] ?? createEmptyState()
    const now = Date.now()
    return {
      characterId,
      currentMood: aggregateMood(state.moodHistory, now),
      currentDesire: state.currentDesire,
      energy: currentEnergyFrom(state.energy, state.lastUpdated, now),
      tsundereLevel: state.tsundereLevel ?? 0,
      lastUpdated: new Date(state.lastUpdated).toISOString(),
      moodHistory: state.moodHistory.slice(-10),
      // No second decay here: the engine already carries the clock for these
      // values, and decaying them again in the UI made the same mood fade at
      // two different speeds depending on which surface you looked at.
      ...(state.vad ? { vad: state.vad } : {}),
      ...(state.moodVad ? { mood: state.moodVad } : {}),
      ...(state.band ? { band: state.band } : {}),
    }
  }

  /**
   * Mirrors the engine's psyche into this character's self-state.
   *
   * The engine owns the affect math (appraisal, decay, bands). The UI only needs the current coordinates so the
   * system prompt and the panel show what she actually feels — before this, a value moved only when the model
   * called a tool, and it never did. The psyche-derived mood replaces the previous psyche event instead of
   * appending, so a periodic sync cannot grow the history.
   */
  function syncPsyche(input: SyncPsycheInput, characterId = activeCharacterId.value) {
    const now = input.at ?? Date.now()
    updateState((state) => {
      // Two answers race: a slow query can land after a tool call already recorded a newer emotion.
      // An older answer must not overwrite it and walk the clock backwards.
      if (state.vadUpdatedAt !== undefined && now < state.vadUpdatedAt)
        return state
      const kept = state.moodHistory.filter(event => event.reason !== 'psyche')
      // The engine says the evidence expired. Continuing to show the old coordinates makes the
      // panel and the prompt assert a feeling the engine no longer holds. Desire, energy and the
      // explicit emotion records stay: those are hers, not the engine's evidence.
      if (input.hasEvidence === false) {
        const cleared: PersistedAgentState = { ...state, vadUpdatedAt: now, moodHistory: kept, lastUpdated: now }
        delete cleared.vad
        delete cleared.moodVad
        delete cleared.band
        return cleared
      }
      if (!input.vad)
        return state
      const mood = Math.max(-10, Math.min(10, Math.round(input.vad.valence * 10)))
      return {
        ...state,
        vad: input.vad,
        ...(input.mood ? { moodVad: input.mood } : {}),
        ...(input.band ? { band: input.band } : {}),
        vadUpdatedAt: now,
        moodHistory: [...kept, { value: mood, reason: 'psyche', timestamp: now }].slice(-50),
      }
    }, characterId)
  }

  function updateState(update: (state: PersistedAgentState) => PersistedAgentState, characterId = activeCharacterId.value) {
    states.value = { ...states.value, [characterId]: update(states.value[characterId] ?? createEmptyState()) }
  }

  function recordMood(value: number, reason: string, characterId = activeCharacterId.value) {
    updateState(state => ({
      ...state,
      moodHistory: [...state.moodHistory, {
        value: Math.max(-10, Math.min(10, Number.isFinite(value) ? value : 0)),
        reason,
        timestamp: Date.now(),
      }].slice(-50),
      lastUpdated: Date.now(),
    }), characterId)
  }

  function recordEmotion(vad: VADVector, reason: string, characterId = activeCharacterId.value) {
    const now = Date.now()
    updateState(state => ({
      ...state,
      moodHistory: [...state.moodHistory, {
        value: Math.max(-10, Math.min(10, vad.valence * 10)),
        reason: reason.trim(),
        timestamp: now,
      }].slice(-50),
      vad,
      vadUpdatedAt: now,
      lastUpdated: now,
    }), characterId)
  }

  function setTsundereLevel(level: number, characterId = activeCharacterId.value) {
    updateState(state => ({ ...state, tsundereLevel: Math.max(0, Math.min(10, level)) }), characterId)
  }

  function setDesire(desire: string, characterId = activeCharacterId.value) {
    updateState(state => ({ ...state, currentDesire: desire.trim() || null, lastUpdated: Date.now() }), characterId)
  }

  function boostEnergy(amount: number, characterId = activeCharacterId.value) {
    updateState(state => ({ ...state, energy: Math.max(0, Math.min(100, snapshotFor(characterId).energy + amount)), lastUpdated: Date.now() }), characterId)
  }

  /**
   * Writes the gauge from the mind's fatigue.
   *
   * The mind owns the sleep loop; this store only mirrors it for the prompt and
   * the panel. Before this the two disagreed: the panel decayed on its own clock
   * and `syncPsyche` reset that clock every five minutes without settling, so
   * the mirror read 100 while the mind was exhausted. Mirroring the number that
   * actually drives sleep removes the second source of truth instead of adding
   * a third.
   */
  function setEnergy(value: number, characterId = activeCharacterId.value) {
    const energy = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
    updateState(state => ({ ...state, energy, lastUpdated: Date.now() }), characterId)
  }

  return {
    enabled,
    activeCharacterId,
    moodHistory: computed(() => activeState.value.moodHistory),
    currentDesire: computed(() => activeState.value.currentDesire),
    currentMood,
    currentEnergy,
    setCharacter,
    snapshotFor,
    recordMood,
    recordEmotion,
    syncPsyche,
    setTsundereLevel,
    setDesire,
    boostEnergy,
    setEnergy,
  }
})
