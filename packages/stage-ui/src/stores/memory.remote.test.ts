import type { MemoryEntry, MemoryRemotePort } from './memory'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from './memory'

function createRemote(seed: MemoryEntry[] = []) {
  const save = vi.fn(async (_entry: MemoryEntry) => {})
  const forget = vi.fn(async (_entry: Pick<MemoryEntry, 'name' | 'persona'>) => true)
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
      forget: async () => true,
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

    const result = memory.forget('nickname', 'airi')
    expect(result.found).toBe(true)
    await expect(result.persisted).resolves.toEqual({ ok: true })
    expect(forget).toHaveBeenCalledWith({ name: 'nickname', persona: 'airi' })
  })

  // The audit's F02: the bank answered `false` and kept the row, while the list had already
  // dropped it — the entry came back on the next hydrate. A refusal must restore the row.
  it('puts the entry back when the backend refuses to forget it', async () => {
    const memory = useMemoryStore()
    const { port } = createRemote()
    memory.attachRemote({ ...port, forget: async () => false })
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    const result = memory.forget('nickname', 'airi')
    expect(result.found).toBe(true)
    await expect(result.persisted).resolves.toMatchObject({ ok: false, reason: 'refused' })
    expect(memory.read('nickname', 'airi')?.body).toBe('Yumeka')
  })

  // A08: the move is two backend calls, and the local row now changes only after both land.
  it('moves a memory to general only after the backend agrees', async () => {
    const memory = useMemoryStore()
    const { port, save, forget } = createRemote()
    memory.attachRemote(port)
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    const result = await memory.makeGeneral({ name: 'nickname', persona: 'airi' })

    expect(result.ok).toBe(true)
    expect(forget).toHaveBeenCalledWith(expect.objectContaining({ name: 'nickname', persona: 'airi' }))
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ name: 'nickname' })
    expect(save.mock.calls[1][0].persona).toBeUndefined()
    expect(memory.entries.find(entry => entry.name === 'nickname')?.persona).toBeUndefined()
  })

  it('keeps the card row when the backend refuses the delete', async () => {
    const memory = useMemoryStore()
    memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => false })
    memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')

    const result = await memory.makeGeneral({ name: 'nickname', persona: 'airi' })

    expect(result.ok).toBe(false)
    expect(memory.entries.find(entry => entry.name === 'nickname')?.persona).toBe('airi')
  })

  // F03: a thrown save used to leave the local row in place, so the tool said "Saved" over a
  // write that never landed. The cache now rolls back and the caller learns why.
  it('rolls the local write back when the remote save fails', async () => {
    const memory = useMemoryStore()
    memory.attachRemote({
      list: async () => [],
      save: async () => { throw new Error('disk full') },
      forget: async () => true,
    })

    const written = memory.write({ name: 'nickname', description: 'how to address', body: 'Yumeka' }, 'airi')
    expect(written.entry?.name).toBe('nickname')
    await expect(written.persisted).resolves.toMatchObject({ ok: false, reason: 'failed', error: 'disk full' })
    expect(memory.read('nickname', 'airi')).toBeUndefined()
  })

  /**
   * F04: a lookup that could not run must not read as "no such memory".
   *
   * The four endings are asserted separately because the tool prints a different sentence for
   * each, and the model repeats that sentence to the owner.
   */
  describe('lookup endings', () => {
    it('reports an attached backend with nothing matched as ok', async () => {
      const memory = useMemoryStore()
      const { port } = createRemote()
      memory.attachRemote({ ...port, search: async () => [] })
      await expect(memory.lookup('birthday')).resolves.toMatchObject({ status: 'ok', hits: [], facts: [] })
    })

    it('reports the absence of a search port as unavailable', async () => {
      const memory = useMemoryStore()
      memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => true })
      await expect(memory.lookup('birthday')).resolves.toMatchObject({ status: 'unavailable' })
    })

    it('reports a thrown lookup as failed, not as an empty memory', async () => {
      const memory = useMemoryStore()
      memory.attachRemote({
        list: async () => [],
        save: async () => {},
        forget: async () => true,
        search: async () => { throw new Error('engine down') },
      })
      await expect(memory.lookup('birthday')).resolves.toMatchObject({ status: 'failed', error: 'engine down' })
    })

    it('keeps the rows when only the fact lookup fails', async () => {
      const memory = useMemoryStore()
      memory.attachRemote({
        list: async () => [],
        save: async () => {},
        forget: async () => true,
        search: async () => [{ text: 'kite flying', score: 1.2 }],
        facts: async () => { throw new Error('facts offline') },
      })
      const result = await memory.lookup('birthday')
      expect(result.status).toBe('partial')
      expect(result.hits.map(hit => hit.text)).toEqual(['kite flying'])
      expect(result.error).toContain('facts offline')
    })
  })

  // F01: the persona has to survive the port, or the backend answers for the configured character
  // while the turn belongs to another card.
  it('passes the asking card to the lookup and the ingest', async () => {
    const memory = useMemoryStore()
    const search = vi.fn(async () => [])
    const facts = vi.fn(async () => [])
    const ingest = vi.fn(async () => ({ ok: true }))
    memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => true, search, facts, ingest })

    await memory.lookup('birthday', 5, 'second-card')
    expect(search).toHaveBeenCalledWith('birthday', 5, 'second-card')
    expect(facts).toHaveBeenCalledWith('birthday', 3, 'second-card')

    await memory.ingestTurn({ user: 'you up?', assistant: 'still here.', persona: 'second-card' })
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ persona: 'second-card' }))
  })

  // F09: rows the backend creates on its own used to stay invisible to `read` and the prompt index
  // until the app restarted. One debounced re-read makes them readable.
  it('re-reads the backend after an ingest so the new row becomes readable', async () => {
    vi.useFakeTimers()
    try {
      const memory = useMemoryStore()
      const durable: MemoryEntry[] = []
      memory.attachRemote({
        list: async () => [...durable],
        save: async () => {},
        forget: async () => true,
        ingest: async () => {
          durable.push(entry('after-ingest', 'the turn was saved'))
          return { ok: true }
        },
      })
      await memory.hydrate()
      expect(memory.read('after-ingest', 'airi')).toBeUndefined()

      await memory.ingestTurn({ user: 'you up?', assistant: 'still here.' })
      await vi.advanceTimersByTimeAsync(2_500)

      expect(memory.read('after-ingest', 'airi')?.body).toBe('the turn was saved')
    }
    finally {
      vi.useRealTimers()
    }
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
