import type { AgentStateSnapshot, MoodEvent } from './agent-state'
import type { VADVector } from './emotion'

import { useStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { aggregateMood, currentEnergyFrom } from './agent-state'
import { decayEmotion } from './emotion'

interface PersistedAgentState {
  moodHistory: MoodEvent[]
  currentDesire: string | null
  energy: number
  lastUpdated: number
  vad?: VADVector
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
    const emotion = state.vad
      ? decayEmotion(state.vad, (now - (state.vadUpdatedAt ?? now)) / 3_600_000, state.tsundereLevel ?? 0, new Date(now))
      : undefined
    return {
      characterId,
      currentMood: aggregateMood(state.moodHistory, now),
      currentDesire: state.currentDesire,
      energy: currentEnergyFrom(state.energy, state.lastUpdated, now),
      tsundereLevel: state.tsundereLevel ?? 0,
      lastUpdated: new Date(state.lastUpdated).toISOString(),
      moodHistory: state.moodHistory.slice(-10),
      ...(emotion ? { vad: emotion.vad } : {}),
    }
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
    setTsundereLevel,
    setDesire,
    boostEnergy,
  }
})
