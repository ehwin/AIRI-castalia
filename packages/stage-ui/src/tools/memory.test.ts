import type { MemoryEntry } from '../stores/memory'

import { describe, expect, it, vi } from 'vitest'

import { composeMemoryPrompt, createMemoryTools, FORGET_MEMORY_TOOL_NAME, READ_MEMORY_TOOL_NAME, SEARCH_MEMORY_TOOL_NAME, WRITE_MEMORY_TOOL_NAME } from './memory'

const entry: MemoryEntry = { name: 'nickname', description: 'What the owner likes to be called.', body: 'Yumeka.', updatedAt: 0 }

function options() {
  return {
    read: vi.fn((name: string) => name === 'nickname' ? entry : undefined),
    search: vi.fn(async (query: string) => query === 'birthday'
      ? [{ text: 'My birthday column says "unknown".', score: 1.4, memType: 'general', createdAt: '2026-10-28T18:55:00.000Z' }]
      : []),
    searchFacts: vi.fn(async (query: string) => query === 'winter'
      ? [{ subject: 'user', predicate: 'name', object: '小托（Xiao Tuo）', confidence: 0.95, similarity: 0.72 }]
      : []),
    write: vi.fn((input: Pick<MemoryEntry, 'name' | 'description' | 'body'>): MemoryEntry => ({ ...input, updatedAt: 0 })),
    forget: vi.fn(() => true),
  }
}

describe('memory tools', () => {
  it('reads, writes, and forgets through the store bound to the run persona', async () => {
    const bound = options()
    const tools = await createMemoryTools(bound)
    const read = tools.find(tool => tool.function.name === READ_MEMORY_TOOL_NAME)!
    const write = tools.find(tool => tool.function.name === WRITE_MEMORY_TOOL_NAME)!
    const forget = tools.find(tool => tool.function.name === FORGET_MEMORY_TOOL_NAME)!
    const call = { messages: [], toolCallId: 'call' }

    expect(tools.map(tool => tool.function.name)).toEqual([READ_MEMORY_TOOL_NAME, SEARCH_MEMORY_TOOL_NAME, WRITE_MEMORY_TOOL_NAME, FORGET_MEMORY_TOOL_NAME])
    // One call reads or writes every entry that the turn needs.
    expect(await read!.execute({ names: ['nickname', 'unknown'] }, call)).toBe('nickname (general): Yumeka.\nNo memory entry named "unknown".')
    expect(await write!.execute({ entries: [{ name: 'nickname', description: 'Yumeka.', body: 'Yumeka.' }, { name: 'city', description: 'Tokyo.', body: 'Tokyo.' }] }, call)).toBe('Saved memory "nickname".\nSaved memory "city".')
    expect(bound.write).toHaveBeenNthCalledWith(1, { name: 'nickname', description: 'Yumeka.', body: 'Yumeka.' })
    expect(bound.write).toHaveBeenNthCalledWith(2, { name: 'city', description: 'Tokyo.', body: 'Tokyo.' })
    expect(await forget!.execute({ name: 'nickname' }, call)).toBe('Forgot memory "nickname".')
  })

  // The model was asked to "go search your memory" with only index reads available, guessed a
  // name, and told the owner nothing was there while the bank held the fact. A real lookup fixes it.
  it('searches the whole bank and reports an honest miss', async () => {
    const bound = options()
    const search = (await createMemoryTools(bound)).find(tool => tool.function.name === SEARCH_MEMORY_TOOL_NAME)!
    const call = { messages: [], toolCallId: 'call' }

    expect(await search!.execute({ query: 'birthday' }, call)).toBe('- My birthday column says "unknown". (sim 1.40 · 2026-10-28 · general)')
    expect(bound.search).toHaveBeenCalledWith('birthday')
    expect(await search!.execute({ query: 'hair colour' }, call)).toBe('No memory matched "hair colour".')
    expect(await search!.execute({}, call)).toBe('Give a search query.')
  })

  // A fact is the one-line answer the rows only imply ("who is 小托"), so it rides along with
  // the search instead of costing a second tool call.
  it('prints the near facts beside the hits, and still answers when no row matches', async () => {
    const bound = { ...options(), search: vi.fn(async () => []) }
    const search = (await createMemoryTools(bound)).find(tool => tool.function.name === SEARCH_MEMORY_TOOL_NAME)!
    const call = { messages: [], toolCallId: 'call' }

    expect(await search!.execute({ query: 'winter' }, call)).toBe('known facts:\n- user · name · 小托（Xiao Tuo）')
    expect(bound.searchFacts).toHaveBeenCalledWith('winter')
    // Facts alone still answer: a query with no matching row must not read as "nothing known".
    expect(await search!.execute({ query: 'nobody' }, call)).toBe('No memory matched "nobody".')
  })

  // A hit is a row, not a blob: the store header becomes the address, so the model can read
  // the entry in full instead of re-searching, and a long hit cannot crowd out the others.
  it('shows a hit as its name plus a bounded body, under a bounded answer', async () => {
    const hits = Array.from({ length: 6 }, (_, index) => {
      const text = index === 0
        ? `# 我的生日\n官方档案写「未知」。\n\n${'细节'.repeat(400)}`
        : `# 第 ${index} 条\n${'又一段'.repeat(200)}`
      return { text, score: 0.73 - index * 0.05, memType: 'general' }
    })
    const bound = { ...options(), search: vi.fn(async () => hits) }
    const search = (await createMemoryTools(bound)).find(tool => tool.function.name === SEARCH_MEMORY_TOOL_NAME)!

    const answer = await search!.execute({ query: '生日' }, { messages: [], toolCallId: 'call' }) as string

    expect(answer).toContain('- 我的生日: 官方档案写「未知」。 细节')
    expect(answer).not.toContain('\n\n\n')
    expect(answer.length).toBeLessThanOrEqual(1500)
    expect(answer).toMatch(/more hits; narrow the query/)
  })

  // Strict function calling rejects a schema whose objects leave a property out of `required`.
  it('declares every write property as required, in each entry too', async () => {
    const write = (await createMemoryTools(options())).find(tool => tool.function.name === WRITE_MEMORY_TOOL_NAME)!
    const parameters = write!.function.parameters as { required: string[], properties: Record<string, unknown>, additionalProperties: boolean }
    const item = (parameters.properties.entries as { items: typeof parameters }).items

    expect(parameters.required.sort()).toEqual(Object.keys(parameters.properties).sort())
    expect(parameters.additionalProperties).toBe(false)
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort())
    expect(item.additionalProperties).toBe(false)
  })

  it('asks for few, plain writes and shows the index', () => {
    expect(composeMemoryPrompt('About you:\n- nickname: d')).toContain('Memory index:\nAbout you:\n- nickname: d')
    expect(composeMemoryPrompt('')).toContain('A line that already states the fact needs no read.')
    expect(composeMemoryPrompt('')).toContain('Most turns save nothing.')
    expect(composeMemoryPrompt('')).toContain('Never save what a recipe already holds')
    // The ambient block is fetched from the message text alone, so a bare "去搜搜" misleads it.
    expect(composeMemoryPrompt('')).toContain('search with the words you mean instead of trusting that block')
    // Measured: a keyword list drops the fact the single phrase finds.
    expect(composeMemoryPrompt('')).toContain('one short phrase')
    // Memory is a reference for voice, not a script to re-enact, and an old line is not now.
    expect(composeMemoryPrompt('')).toContain('Memory is reference, not a script.')
    expect(composeMemoryPrompt('')).toContain('not of now')
    expect(composeMemoryPrompt('')).toContain('The memory index is empty.')
  })
})
