import type { MemoryEntry } from '../src/stores/memory'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from '../src/stores/memory'
import { createMemoryTools, SEARCH_MEMORY_TOOL_NAME } from '../src/tools/memory'

let pinia: ReturnType<typeof createPinia>

describe('castalia link review: real renderer memory store', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.restoreAllMocks()
  })

  // A04 (fixed): a backend that cannot search must answer "unavailable", not "nothing matched",
  // and the failed capability must not count as a healthy call.
  it('reports unavailable when the backend explicitly disables search and facts', async () => {
    const memory = useMemoryStore()
    memory.enabled = true
    memory.setBackend({
      transport: 'entry-only',
      capabilities: { vadSweep: false, recall: false, search: false, facts: false, ingest: false, maintain: false, selfCycle: false, psyche: false },
      checkedAt: Date.now(),
    })
    memory.attachRemote({
      list: async () => [],
      save: async () => {},
      forget: async () => true,
      search: async () => [],
      facts: async () => [],
    })
    const tools = await createMemoryTools({
      read: name => memory.read(name, 'airi'),
      write: entry => memory.write(entry, 'airi'),
      forget: name => memory.forget(name, 'airi'),
      lookup: query => memory.lookup(query, 5, 'airi'),
    })
    const search = tools.find(tool => tool.function.name === SEARCH_MEMORY_TOOL_NAME)!
    const answer = await search.execute({ query: 'known-fact' }, { messages: [], toolCallId: 'audit' })

    expect(answer).not.toContain('No memory matched')
    expect(answer.toLowerCase()).toContain('unavailable')
    expect(memory.remoteHealth.okCount).toBe(0)
  })

  // A08 (fixed): the row keeps its card until both backend calls land.
  it('leaves the entry on its card when the durable move fails', async () => {
    const memory = useMemoryStore()
    const original: MemoryEntry = { id: 'raw-row-id', name: 'mem-raw', description: 'Raw fact', body: 'Private fact', persona: 'airi', updatedAt: 1 }
    const forget = vi.fn(async () => false)
    const save = vi.fn(async () => {
      throw new Error('audit: durable save failed')
    })
    memory.attachRemote({ list: async () => [original], save, forget })
    await memory.hydrate()

    const result = await memory.makeGeneral(original)

    expect(result.ok).toBe(false)
    expect(forget).toHaveBeenCalledWith(expect.objectContaining({ id: 'raw-row-id', name: 'mem-raw', persona: 'airi' }))
    expect(memory.entries.find(entry => entry.name === 'mem-raw')?.persona).toBe('airi')
    expect(memory.read('mem-raw', 'unrelated-card')).toBeUndefined()
  })
})
