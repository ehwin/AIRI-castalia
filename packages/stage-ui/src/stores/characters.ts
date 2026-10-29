import type { Character, CreateCharacterPayload, UpdateCharacterPayload } from '../types/character'

import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { charactersModel } from '../models/characters'
import { buildLocalCharacter } from '../services/characters'

function setCharactersMap(target: Map<string, Character>, characters: Character[]) {
  target.clear()
  for (const character of characters) {
    target.set(character.id, character)
  }
}

/** Owns the character library that lives on this device. */
export const useCharacterStore = defineStore('characters', () => {
  const characters = ref<Map<string, Character>>(new Map())
  const isLoading = ref(false)
  const error = ref<string>()

  async function fetchList() {
    isLoading.value = true
    error.value = undefined

    try {
      const stored = await charactersModel.list()
      setCharactersMap(characters.value, stored)
      return stored
    }
    catch (cause) {
      error.value = errorMessageFrom(cause) ?? 'Failed to read characters'
      return []
    }
    finally {
      isLoading.value = false
    }
  }

  async function fetchById(id: string) {
    const cached = characters.value.get(id) ?? (await charactersModel.list()).find(character => character.id === id)
    if (!cached)
      return undefined

    characters.value.set(cached.id, cached)
    return cached
  }

  async function create(payload: CreateCharacterPayload) {
    const character = buildLocalCharacter(payload)
    characters.value.set(character.id, character)
    await charactersModel.upsert(character)
    return character
  }

  async function update(id: string, payload: UpdateCharacterPayload) {
    const character = characters.value.get(id)
    if (!character)
      return undefined

    const updated = {
      ...character,
      ...(payload.version !== undefined ? { version: payload.version } : {}),
      ...(payload.coverUrl !== undefined ? { coverUrl: payload.coverUrl } : {}),
      ...(payload.characterId !== undefined ? { characterId: payload.characterId } : {}),
      updatedAt: new Date(),
    }
    characters.value.set(updated.id, updated)
    await charactersModel.upsert(updated)
    return updated
  }

  async function remove(id: string) {
    characters.value.delete(id)
    await charactersModel.remove(id)
  }

  function getCharacter(id: string) {
    return characters.value.get(id)
  }

  return {
    characters,
    isLoading,
    error,

    fetchList,
    fetchById,
    create,
    update,
    remove,
    getCharacter,
  }
})
