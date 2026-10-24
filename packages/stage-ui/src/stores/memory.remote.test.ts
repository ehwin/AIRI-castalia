import type { MemoryEntry, MemoryRemotePort } from './memory'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from './memory'

function createRemote(seed: MemoryEntry[] = []) {
  const save = vi.fn(async (_entry: MemoryEntry) => {})
  const forget = vi.fn(async (_entry: Pick<MemoryEntry, 'name' | 'persona'>) => {})
  const list = vi.fn(async () => seed)
  const port: MemoryRemotePort = { list, save, forget }
  return { port, list, save, forget }
}

const entry = (name: string, body: string, persona = 'airi'): MemoryEntry => ({
  name,
  description: `${name} line`,
  body,
  persona,
  updatedAt: 1,
})

describe('memory store remote port', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('works without a remote', () => {
    const memory = useMemoryStore()
    expect(memory.hydrate()).resolves.toBe(false)
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')
    expect(memory.read('nickname', 'airi')?.body).toBe('Yumeka')
    expect(memory.remoteAttached).toBe(false)
  })

  it('replaces the cache with the remote state', async () => {
    const memory = useMemoryStore()
    memory.write({ name: 'stale', description: 'gone', body: 'gone' }, 'airi')

    const { port } = createRemote([entry('nickname', 'Yumeka')])
    memory.attachRemote(port)

    await expect(memory.hydrate()).resolves.toBe(true)
    expect(memory.entries.map(item => item.name)).toEqual(['nickname'])
    expect(memory.remoteAttached).toBe(true)
  })

  it('keeps the cache when the remote fails', async () => {
    const memory = useMemoryStore()
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    memory.attachRemote({
      list: async () => { throw new Error('offline') },
      save: async () => {},
      forget: async () => {},
    })

    await expect(memory.hydrate()).resolves.toBe(false)
    expect(memory.read('nickname', 'airi')?.body).toBe('Yumeka')
  })

  it('mirrors a write to the remote', async () => {
    const memory = useMemoryStore()
    const { port, save } = createRemote()
    memory.attachRemote(port)

    memory.write({ name: 'Nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    expect(memory.read('nickname', 'airi')?.body).toBe('Yumeka')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ name: 'nickname', persona: 'airi' })
  })

  it('mirrors a forget to the remote', async () => {
    const memory = useMemoryStore()
    const { port, forget } = createRemote()
    memory.attachRemote(port)
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    expect(memory.forget('nickname', 'airi')).toBe(true)
    expect(forget).toHaveBeenCalledWith({ name: 'nickname', persona: 'airi' })
  })

  it('moves a memory to general on the remote too', async () => {
    const memory = useMemoryStore()
    const { port, save, forget } = createRemote()
    memory.attachRemote(port)
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    memory.makeGeneral({ name: 'nickname', persona: 'airi' })

    expect(forget).toHaveBeenCalledWith({ name: 'nickname', persona: 'airi' })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ name: 'nickname' })
    expect(save.mock.calls[1][0].persona).toBeUndefined()
  })

  it('keeps the local write when the remote save fails', async () => {
    const memory = useMemoryStore()
    memory.attachRemote({
      list: async () => [],
      save: async () => { throw new Error('disk full') },
      forget: async () => {},
    })

    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')
    await Promise.resolve()

    expect(memory.read('nickname', 'airi')?.body).toBe('Yumeka')
  })

  it('stops mirroring after detaching', async () => {
    const memory = useMemoryStore()
    const { port, save } = createRemote()
    memory.attachRemote(port)
    memory.attachRemote(undefined)

    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')
    expect(save).not.toHaveBeenCalled()
    expect(memory.remoteAttached).toBe(false)
  })
})
