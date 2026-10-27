import type { Character, CreateCharacterPayload } from '../types/character'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { charactersModel } from '../models/characters'
import { useCharacterStore } from './characters'

vi.mock('../models/characters', () => ({
  charactersModel: {
    list: vi.fn(async () => []),
    saveAll: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
}))

const storedCharacter = {
  id: 'character-1',
  version: '1',
  coverUrl: 'cover.png',
  characterId: 'airi',
  creatorId: 'local',
  ownerId: 'local',
  priceCredit: '0',
  likesCount: 0,
  bookmarksCount: 0,
  interactionsCount: 0,
  forksCount: 0,
  createdAt: new Date('2026-05-08T00:00:00.000Z'),
  updatedAt: new Date('2026-05-08T00:00:00.000Z'),
  capabilities: [],
  avatarModels: [],
  i18n: [],
  prompts: [],
} satisfies Character

const payload = {
  character: { version: '1', coverUrl: 'cover.png', characterId: 'airi' },
  capabilities: [],
  avatarModels: [],
  i18n: [],
  prompts: [],
} satisfies CreateCharacterPayload

/**
 * @example
 * describe('store characters', () => {})
 */
describe('store characters', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(charactersModel.list).mockReset()
    vi.mocked(charactersModel.list).mockImplementation(async () => [])
    vi.mocked(charactersModel.upsert).mockReset()
    vi.mocked(charactersModel.remove).mockReset()
  })

  /**
   * @example
   * await store.fetchList()
   */
  it('reads the stored characters into the map', async () => {
    vi.mocked(charactersModel.list).mockResolvedValueOnce([storedCharacter])
    const store = useCharacterStore()

    await store.fetchList()

    expect(store.characters.get('character-1')).toEqual(storedCharacter)
  })

  /**
   * @example
   * await store.create(payload)
   */
  it('creates a local character and persists it', async () => {
    const store = useCharacterStore()

    const character = await store.create(payload)

    expect(character.ownerId).toBe('local')
    expect(store.characters.get(character.id)).toEqual(character)
    expect(charactersModel.upsert).toHaveBeenCalledWith(character)
  })

  /**
   * @example
   * await store.update('character-1', { version: '2' })
   */
  it('updates the stored character and keeps the other fields', async () => {
    vi.mocked(charactersModel.list).mockResolvedValueOnce([storedCharacter])
    const store = useCharacterStore()
    await store.fetchList()

    const updated = await store.update('character-1', { version: '2' })

    expect(updated?.version).toBe('2')
    expect(updated?.coverUrl).toBe('cover.png')
    expect(charactersModel.upsert).toHaveBeenCalledWith(updated)
  })

  /**
   * @example
   * await store.remove('character-1')
   */
  it('removes the character from the map and the storage', async () => {
    vi.mocked(charactersModel.list).mockResolvedValueOnce([storedCharacter])
    const store = useCharacterStore()
    await store.fetchList()

    await store.remove('character-1')

    expect(store.characters.has('character-1')).toBe(false)
    expect(charactersModel.remove).toHaveBeenCalledWith('character-1')
  })
})
