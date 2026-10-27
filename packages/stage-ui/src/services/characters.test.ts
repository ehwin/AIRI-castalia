import type { CreateCharacterPayload } from '../types/character'

import { describe, expect, it } from 'vitest'

import { buildLocalCharacter } from './characters'

const payload = {
  character: {
    version: '1',
    coverUrl: 'cover.png',
    characterId: 'airi',
  },
  capabilities: [],
  avatarModels: [],
  i18n: [],
  prompts: [],
} satisfies CreateCharacterPayload

/**
 * @example
 * describe('services characters', () => {})
 */
describe('services characters', () => {
  /**
   * @example
   * const character = buildLocalCharacter(payload)
   */
  it('builds a schema-valid character owned by this device', () => {
    const character = buildLocalCharacter(payload)

    expect(character.id).toBeDefined()
    expect(character.creatorId).toBe('local')
    expect(character.ownerId).toBe('local')
    expect(character.characterId).toBe('airi')
    expect(character.likes).toEqual([])
    expect(character.bookmarks).toEqual([])
  })

  /**
   * @example
   * const character = buildLocalCharacter({ ...payload, character: { ...payload.character, id: 'fixed' } })
   */
  it('keeps the payload id and gives each relation its own id', () => {
    const character = buildLocalCharacter({
      ...payload,
      character: { ...payload.character, id: 'fixed' },
      i18n: [{ language: 'en', name: 'Airi', description: 'An AI companion', tags: ['companion'] }],
    })

    expect(character.id).toBe('fixed')
    expect(character.i18n?.[0].id).toBeDefined()
    expect(character.i18n?.[0].characterId).toBe('fixed')
  })
})
