import memoryDriver from 'unstorage/drivers/memory'

import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Replace the IDB-backed storage with an in-memory driver for tests; the
// repo's behavior is identical regardless of the underlying driver.
vi.mock('../storage', () => ({
  storage: createStorage({ driver: memoryDriver() }),
}))
vi.mock('./chat-assets.repo')

const { chatSessionsRepo } = await import('./chat-sessions.repo')
const { storage } = await import('../storage')

beforeEach(async () => {
  await storage.clear()
})

describe('chatSessionsRepo', () => {
  it('returns an index and a session that were saved', async () => {
    await chatSessionsRepo.saveIndex({
      userId: 'local',
      characters: { 'char-a': { activeSessionId: 's1', sessions: { s1: { sessionId: 's1', userId: 'local', characterId: 'char-a', createdAt: 0, updatedAt: 0 } } } },
    })
    await chatSessionsRepo.saveSession('s1', {
      meta: { sessionId: 's1', userId: 'local', characterId: 'char-a', createdAt: 0, updatedAt: 0 },
      messages: [],
    })

    expect((await chatSessionsRepo.getIndex('local'))?.characters['char-a'].sessions.s1).toBeDefined()
    expect((await chatSessionsRepo.getSession('s1'))?.meta.characterId).toBe('char-a')
  })

  it('returns nothing for an unknown session', async () => {
    expect(await chatSessionsRepo.getSession('missing')).toBeNull()
  })

  it('keeps the sessions of another owner apart', async () => {
    await chatSessionsRepo.saveIndex({ userId: 'local', characters: {} })
    await chatSessionsRepo.saveIndex({ userId: 'other', characters: {} })

    expect((await chatSessionsRepo.getIndex('local'))?.userId).toBe('local')
    expect((await chatSessionsRepo.getIndex('other'))?.userId).toBe('other')
  })
})

describe('chatSessionsRepo.clear', () => {
  /**
   * @example
   * clear() removes the index and every session of the user.
   */
  it('removes index and sessions for the user', async () => {
    await chatSessionsRepo.saveIndex({
      userId: 'local',
      characters: { 'char-a': { activeSessionId: 's1', sessions: { s1: { sessionId: 's1', userId: 'local', characterId: 'char-a', createdAt: 0, updatedAt: 0 } } } },
    })
    await chatSessionsRepo.saveSession('s1', { meta: { sessionId: 's1', userId: 'local', characterId: 'char-a', createdAt: 0, updatedAt: 0 }, messages: [] })

    await chatSessionsRepo.clear('local')

    expect(await chatSessionsRepo.getIndex('local')).toBeNull()
    expect(await chatSessionsRepo.getSession('s1')).toBeNull()
  })
})
