import type { CreateCharacterPayload } from '../types/character'

import { describe, expect, it } from 'vitest'

import { buildLocalCharacter } from './characters'

const payload = {
  character: {
    version: '1',
    coverUrl: 'cover.png',
    characterId: 'airi',
  },
  capabilities: [{ type: 'llm', config: { apiKey: 'test-key', apiBaseUrl: '' } }],
  avatarModels: [{ name: 'Live2D', type: 'live2d', description: '', config: {} }],
  i18n: [{ language: 'en', name: 'Airi', description: '', tags: [] }],
  prompts: [{ language: 'en', type: 'system', content: 'You are Airi.' }],
} satisfies CreateCharacterPayload

/**
 * The character manager creates a character on this device.
 *
 * The hosted characters API went with the account layer, so the service builds a local row and
 * sends nothing. These tests pin what a local row carries.
 */
describe('services characters', () => {
  it('builds a character owned by this device', () => {
    const character = buildLocalCharacter(payload)

    expect(character.id).toBeTruthy()
    expect(character.creatorId).toBe('local')
    expect(character.ownerId).toBe('local')
    expect(character.characterId).toBe('airi')
    expect(character.likes).toEqual([])
    expect(character.bookmarks).toEqual([])
  })

  it('gives every relation the new character id', () => {
    const character = buildLocalCharacter(payload)

    expect(character.capabilities).toHaveLength(1)
    expect(character.capabilities?.[0]?.characterId).toBe(character.id)
    expect(character.avatarModels?.[0]?.characterId).toBe(character.id)
    expect(character.i18n?.[0]?.characterId).toBe(character.id)
    expect(character.prompts?.[0]?.characterId).toBe(character.id)
    expect(character.prompts?.[0]?.content).toBe('You are Airi.')
  })

  it('keeps the id that the payload already carries', () => {
    const character = buildLocalCharacter({ ...payload, character: { ...payload.character, id: 'airi-local' } })

    expect(character.id).toBe('airi-local')
    expect(character.prompts?.[0]?.characterId).toBe('airi-local')
  })
})
