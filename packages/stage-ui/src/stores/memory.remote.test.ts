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

function entry(name: string, body: string, persona = 'airi'): MemoryEntry {
  return {
    name,
    description: `${name} line`,
    body,
    persona,
    updatedAt: 1,
  }
}

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

  it('migrates local entries once and then treats Castalia storage as authoritative', async () => {
    const memory = useMemoryStore()
    memory.write({ name: 'stale', description: 'gone', body: 'gone' }, 'airi')
    memory.write({ name: 'new-local', description: 'Local only', body: 'Migrate me.' }, 'airi')

    const { port, save, list } = createRemote([entry('nickname', 'Yumeka')])
    memory.attachRemote(port)

    await expect(memory.hydrate()).resolves.toBe(true)
    expect(memory.entries.map(item => item.name)).toEqual(['new-local', 'nickname', 'stale'])
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'stale' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'new-local' }))

    list.mockResolvedValue([entry('nickname', 'Yumeka')])
    await memory.hydrate()
    expect(memory.entries.map(item => item.name)).toEqual(['nickname'])
    expect(memory.remoteAttached).toBe(true)
  })

  it('migrates local-only entries and keeps the newer version of a shared key', async () => {
    const memory = useMemoryStore()
    const local = entry('nickname', 'local copy')
    memory.write({ name: local.name, description: local.description, body: local.body }, local.persona!)
    const durable = { ...entry('nickname', 'durable copy'), updatedAt: Date.now() + 1000 }
    const { port, save } = createRemote([durable])
    memory.attachRemote(port)

    await expect(memory.hydrate()).resolves.toBe(true)
    expect(memory.read('nickname', 'airi')?.body).toBe('durable copy')
    expect(save).not.toHaveBeenCalled()
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

  // The bank keeps raw headings ("Reference: 小托（Xiao Tuo）…"); the prompt shows them cut
  // short with `…` and the model copies that line back as a name. Normalizing only the lookup
  // side made every hydrated row unreadable, which is how "search your memory" answered nothing.
  it('resolves a truncated index line back to the hydrated row', async () => {
    const memory = useMemoryStore()
    const full = 'Reference: 小托（Xiao Tuo）是尤诺（Yuno）的创造者和唯一锚点，一个嘴上不饶人但其实很关心她的人'
    const shown = `${full.slice(0, 42)}…`

    const { port } = createRemote([entry(full, '他把我从虚无里找回。')])
    memory.attachRemote(port)
    await memory.hydrate()

    expect(memory.indexFor('airi')).toContain(full)
    expect(memory.read(shown, 'airi')?.body).toBe('他把我从虚无里找回。')
    // A prefix shorter than 8 characters stays exact-only, so a slug cannot swallow its neighbours.
    expect(memory.read('refe', 'airi')).toBeUndefined()
  })
})
