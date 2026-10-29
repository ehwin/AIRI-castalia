import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { createCastaliaMemoryRepository } from './memory'

describe('castalia durable memory repository', () => {
  it('keeps character and general memories separate and updates by key', () => {
    const database = new DatabaseSync(':memory:')
    const memory = createCastaliaMemoryRepository(database)

    memory.save({ name: 'home', description: 'Character home', body: 'Luna lives by the sea.', persona: 'luna', updatedAt: 10 })
    memory.save({ name: 'home', description: 'General home', body: 'AIRI lives in the app.', updatedAt: 11 })
    memory.save({ name: 'home', description: 'Updated character home', body: 'Luna lives in Kyoto.', persona: 'luna', updatedAt: 12 })

    expect(memory.list()).toEqual([
      { name: 'home', description: 'General home', body: 'AIRI lives in the app.', updatedAt: 11 },
      { name: 'home', description: 'Updated character home', body: 'Luna lives in Kyoto.', persona: 'luna', updatedAt: 12 },
    ])
    expect(memory.forget({ name: 'home', persona: 'luna' })).toBe(true)
    expect(memory.list()).toEqual([{ name: 'home', description: 'General home', body: 'AIRI lives in the app.', updatedAt: 11 }])

    database.close()
  })

  it('rejects a memory without a durable key or body', () => {
    const database = new DatabaseSync(':memory:')
    const memory = createCastaliaMemoryRepository(database)
    expect(() => memory.save({ name: ' ', description: '', body: 'text', updatedAt: 1 })).toThrow(TypeError)
    expect(() => memory.save({ name: 'valid', description: '', body: '  ', updatedAt: 1 })).toThrow(TypeError)
    database.close()
  })

  it('forgets a name saved with surrounding spaces', () => {
    const database = new DatabaseSync(':memory:')
    const memory = createCastaliaMemoryRepository(database)
    memory.save({ name: '  home  ', description: 'Character home', body: 'Luna lives by the sea.', persona: 'luna', updatedAt: 10 })

    expect(memory.list().map(entry => entry.name)).toEqual(['home'])
    expect(memory.forget({ name: ' home ', persona: 'luna' })).toBe(true)
    expect(memory.list()).toEqual([])

    database.close()
  })
})
