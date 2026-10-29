import type { Character, CreateCharacterPayload } from '../types/character'

import { nanoid } from 'nanoid'
import { parse } from 'valibot'

import { CharacterWithRelationsSchema } from '../types/character'

/** Owner of a character that a user creates on this device. */
const LOCAL_OWNER_ID = 'local'

/**
 * Builds a validated character that lives only on this device.
 *
 * Use when:
 * - The character manager creates a character.
 *
 * Expects:
 * - The payload passed the create schema.
 *
 * Returns:
 * - A character with a new id, local owner fields, and one id for each relation.
 */
export function buildLocalCharacter(payload: CreateCharacterPayload): Character {
  const id = payload.character.id ?? nanoid()
  const now = new Date()

  return parse(CharacterWithRelationsSchema, {
    id,
    version: payload.character.version,
    coverUrl: payload.character.coverUrl,
    avatarUrl: undefined,
    characterAvatarUrl: undefined,
    coverBackgroundUrl: undefined,
    creatorRole: undefined,
    priceCredit: '0',
    likesCount: 0,
    bookmarksCount: 0,
    interactionsCount: 0,
    forksCount: 0,
    creatorId: LOCAL_OWNER_ID,
    ownerId: LOCAL_OWNER_ID,
    characterId: payload.character.characterId,
    createdAt: now,
    updatedAt: now,
    deletedAt: undefined,
    capabilities: payload.capabilities?.map(capability => ({
      id: nanoid(),
      characterId: id,
      type: capability.type,
      config: capability.config,
    })),
    avatarModels: payload.avatarModels?.map(model => ({
      id: nanoid(),
      characterId: id,
      name: model.name,
      type: model.type,
      description: model.description,
      config: model.config,
      createdAt: now,
      updatedAt: now,
    })),
    i18n: payload.i18n?.map(item => ({
      id: nanoid(),
      characterId: id,
      language: item.language,
      name: item.name,
      description: item.description,
      tags: item.tags,
      createdAt: now,
      updatedAt: now,
    })),
    prompts: payload.prompts?.map(prompt => ({
      id: nanoid(),
      characterId: id,
      language: prompt.language,
      type: prompt.type,
      content: prompt.content,
    })),
    likes: [],
    bookmarks: [],
  })
}
