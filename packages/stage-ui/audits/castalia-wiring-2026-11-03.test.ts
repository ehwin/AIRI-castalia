import type { MemoryEntry } from '../src/stores/memory'

import { formatAgentStatePrompt, useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryStore } from '../src/stores/memory'
import { createMemoryTools, FORGET_MEMORY_TOOL_NAME, SEARCH_MEMORY_TOOL_NAME, WRITE_MEMORY_TOOL_NAME } from '../src/tools/memory'

function toolsFor(memory: ReturnType<typeof useMemoryStore>) {
  return createMemoryTools({
    read: name => memory.read(name, 'airi'),
    write: entry => memory.write(entry, 'airi'),
    forget: name => memory.forget(name, 'airi'),
    lookup: query => memory.lookup(query),
  })
}

// These probes document the audited behavior. A passing probe can confirm a defect.
describe('castalia wiring audit: renderer boundaries', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // F03 (fixed): the tool used to answer "Saved"/"Forgot" over a backend that had just thrown.
  // It now waits for the durable answer and says so.
  it('reports NOT saved when the durable write rejects', async () => {
    const memory = useMemoryStore()
    const save = vi.fn(async () => {
      throw new Error('audit: disk full')
    })
    memory.attachRemote({ list: async () => [], save, forget: async () => true })
    const tools = await toolsFor(memory)
    const writeTool = tools.find(tool => tool.function.name === WRITE_MEMORY_TOOL_NAME)!
    const call = { messages: [], toolCallId: 'audit' }

    const written = await writeTool.execute({ entries: [{ name: 'audit-fact', description: 'A fact', body: 'Temporary audit data' }] }, call)

    expect(written).toContain('was NOT saved')
    expect(written).toContain('disk full')
    expect(save).toHaveBeenCalledOnce()
    expect(memory.remoteHealth.failureCount).toBe(1)
    // The optimistic local row was rolled back: the list no longer claims what the backend refused.
    expect(memory.read('audit-fact', 'airi')).toBeUndefined()
  })

  // F02 (fixed): a `false` from the backend is a refusal, not a success.
  it('reports NOT forgotten when the durable delete refuses', async () => {
    const memory = useMemoryStore()
    const forget = vi.fn(async () => false)
    memory.attachRemote({ list: async () => [], save: async () => {}, forget })
    memory.write({ name: 'audit-fact', description: 'A fact', body: 'Temporary audit data' }, 'airi')
    const forgetTool = (await toolsFor(memory)).find(tool => tool.function.name === FORGET_MEMORY_TOOL_NAME)!

    const forgotten = await forgetTool.execute({ name: 'audit-fact' }, { messages: [], toolCallId: 'audit' })

    expect(forgotten).toContain('was NOT forgotten')
    expect(forget).toHaveBeenCalledOnce()
    expect(memory.read('audit-fact', 'airi')).toBeDefined()
  })

  // F04 (fixed): a lookup that could not run is no longer reported as an absent fact.
  it('reports a failed lookup instead of a memory miss when both searches reject', async () => {
    const memory = useMemoryStore()
    memory.enabled = true
    memory.attachRemote({
      list: async () => [],
      save: async () => {},
      forget: async () => true,
      search: async () => {
        throw new Error('audit: backend unavailable')
      },
      facts: async () => {
        throw new Error('audit: backend unavailable')
      },
    })
    const searchTool = (await toolsFor(memory)).find(tool => tool.function.name === SEARCH_MEMORY_TOOL_NAME)!

    const result = await searchTool.execute({ query: 'audit fact' }, { messages: [], toolCallId: 'audit' }) as string

    expect(result).toContain('Memory lookup failed')
    expect(result).not.toContain('No memory matched')
    expect(memory.remoteHealth.failureCount).toBe(2)
    expect(memory.remoteDegraded).toBe(true)
  })

  // F09 (still open, tracked): the read cache is hydrated once, so a row the backend generated
  // later is searchable but not readable until the next hydrate.
  it('finds a new backend entry through search before the local read cache sees it', async () => {
    const memory = useMemoryStore()
    memory.enabled = true
    const durable: MemoryEntry[] = []
    memory.attachRemote({
      list: async () => [...durable],
      save: async () => {},
      forget: async () => true,
      search: async () => durable.map(entry => ({ text: entry.body, score: 1 })),
    })
    expect(await memory.hydrate()).toBe(true)
    durable.push({ name: 'new-backend-fact', description: 'A new fact', body: 'Backend generated fact', persona: 'airi', updatedAt: 1 })

    expect((await memory.lookup('new fact')).hits).toHaveLength(1)
    expect(memory.read('new-backend-fact', 'airi')).toBeUndefined()
    expect(memory.indexFor('airi')).not.toContain('new-backend-fact')
    expect(await memory.hydrate()).toBe(true)
    expect(memory.read('new-backend-fact', 'airi')?.body).toBe('Backend generated fact')
  })

  // F10 (fixed): the slider now shapes the prompt, so the panel's promise has a consumer.
  it('reflects the tsundere level in the prompt and still responds to emotion tools', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-03T05:00:00.000Z'))
    const castalia = useCastaliaPluginStore()
    castalia.recordMood(4, 'A pleasant conversation', 'airi')
    castalia.setTsundereLevel(0, 'airi')
    const low = formatAgentStatePrompt(castalia.snapshotFor('airi'))
    castalia.setTsundereLevel(10, 'airi')
    const high = formatAgentStatePrompt(castalia.snapshotFor('airi'))

    expect(low.length).toBeGreaterThan(0)
    expect(castalia.snapshotFor('airi').tsundereLevel).toBe(10)
    expect(high).not.toBe(low)
    expect(high).toContain('prickly at level 10/10')
    expect(low).not.toContain('prickly at level')

    castalia.recordEmotion({ valence: -0.9, arousal: 0.8, dominance: -0.7 }, 'A frightening event', 'airi')
    expect(formatAgentStatePrompt(castalia.snapshotFor('airi'))).not.toBe(high)
  })
})
