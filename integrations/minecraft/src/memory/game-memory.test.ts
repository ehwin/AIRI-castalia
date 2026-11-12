import type { MemoryMcpClient } from './game-memory'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GameMemory, resetGameMemory } from './game-memory'

function fakeClient(handlers: {
  callTool?: (params: { name: string, arguments: Record<string, unknown> }) => Promise<{ content?: Array<{ type?: string, text?: string }> }>
}) {
  const calls: Array<{ name: string, arguments: Record<string, unknown> }> = []
  const client: MemoryMcpClient = {
    callTool: async (params) => {
      calls.push(params)
      if (!handlers.callTool)
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
      return handlers.callTool(params)
    },
    close: async () => {},
  }
  return { client, calls }
}

function json(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

afterEach(() => {
  resetGameMemory()
  vi.useRealTimers()
})

describe('gameMemory', () => {
  it('writes a place with the project partition and the mc:place category', async () => {
    const { client, calls } = fakeClient({ callTool: async () => json({ ok: true, id: 'abcdef123456' }) })
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    const result = await memory.remember({ kind: 'place', text: '# 地点: 主屋\nx 120 y 64 z -330', tags: ['mc', 'server:localhost_25565'] })

    expect(result.ok).toBe(true)
    expect(result.id).toBe('abcdef123456')
    const saves = calls.filter(call => call.name === 'memory_save')
    expect(saves).toHaveLength(1)
    expect(saves[0].arguments).toMatchObject({
      project: 'minecraft',
      memType: 'project',
      category: 'mc:place',
      source: 'minecraft-bot',
      tags: ['mc', 'server:localhost_25565'],
    })
  })

  it('writes a diary row as general because the MCP schema rejects memType=diary', async () => {
    const { client, calls } = fakeClient({})
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    await memory.remember({ kind: 'diary', text: '# diary-2026-11-06\n\n挖了一晚上铁矿' })

    expect(calls[0].arguments).toMatchObject({ memType: 'general', category: 'mc:diary' })
  })

  it('never lets two writes overlap, which is what closes the engine dedupe race', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const client: MemoryMcpClient = {
      callTool: async (params) => {
        if (params.name !== 'memory_save')
          return json({ ok: true, results: [] })
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(resolve => setTimeout(resolve, 15))
        inFlight -= 1
        return json({ ok: true, id: `row-${String(params.arguments.text).length}` })
      },
      close: async () => {},
    }
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    await Promise.all([
      memory.remember({ kind: 'event', text: '# 事件: 一' }),
      memory.remember({ kind: 'event', text: '# 事件: 二' }),
      memory.remember({ kind: 'event', text: '# 事件: 三' }),
    ])

    expect(maxInFlight).toBe(1)
  })

  it('removes the extra rows the engine wrote for the same text, and keeps its own', async () => {
    const text = '# 地点: 主屋\nx 120 y 64 z -330'
    const deleted: string[] = []
    const client: MemoryMcpClient = {
      callTool: async (params) => {
        if (params.name === 'memory_save')
          return json({ ok: true, id: 'keep' })
        if (params.name === 'memory_search')
          return json({ ok: true, results: [{ id: 'keep' }, { id: 'dup-1' }, { id: 'dup-2' }] })
        if (params.name === 'memory_get') {
          const id = params.arguments.id as string
          return json({ ok: true, id, text: id === 'dup-2' ? '# 地点: 另一个地方' : text })
        }
        if (params.name === 'memory_delete') {
          deleted.push(params.arguments.id as string)
          return json({ ok: true, deleted: true })
        }
        return json({ ok: true })
      },
      close: async () => {},
    }
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    const result = await memory.remember({ kind: 'place', text })

    expect(result.ok).toBe(true)
    expect(result.id).toBe('keep')
    expect(result.collapsed).toBe(1)
    expect(deleted).toEqual(['dup-1'])
  })

  it('reads search hits out of the tool payload', async () => {
    const { client } = fakeClient({
      callTool: async () => json({ ok: true, results: [
        { id: '1', text: '# 地点: 主屋 x 120 y 64 z -330', category: 'mc:place', score: 0.9 },
        { id: '2', summary: '主人要一座桥', category: 'mc:plan' },
        { id: '3' },
      ] }),
    })
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    const hits = await memory.search('主屋 在哪', 3)

    expect(hits).toHaveLength(2)
    expect(hits[0].text).toContain('x 120 y 64 z -330')
    expect(hits[1].text).toBe('主人要一座桥')
  })

  it('answers empty instead of throwing when the bridge is down, then cools down', async () => {
    let attempts = 0
    const memory = new GameMemory({
      url: 'http://127.0.0.1:3320/mcp',
      factory: async () => {
        attempts += 1
        throw new Error('ECONNREFUSED')
      },
      logger: null,
    })

    await expect(memory.search('anything')).resolves.toEqual([])
    const write = await memory.remember({ kind: 'event', text: '# 事件: 掉进岩浆' })

    expect(write.ok).toBe(false)
    expect(attempts).toBe(1)
    expect(memory.available).toBe(false)
    expect(memory.lastErrorMessage).toContain('ECONNREFUSED')
  })

  it('treats ok:false from the engine as a failed write', async () => {
    const { client } = fakeClient({ callTool: async () => json({ ok: false, error: 'database is locked' }) })
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    const result = await memory.remember({ kind: 'world', text: '# 世界: 1.20 生存服' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('database is locked')
  })

  it('rejects an empty text without calling the bridge', async () => {
    const { client, calls } = fakeClient({})
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', factory: async () => client, logger: null })

    const result = await memory.remember({ kind: 'event', text: '   ' })

    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('does nothing at all while disabled', async () => {
    const { client, calls } = fakeClient({})
    const memory = new GameMemory({ url: 'http://127.0.0.1:3320/mcp', enabled: false, factory: async () => client, logger: null })

    expect(await memory.search('主屋')).toEqual([])
    expect((await memory.remember({ kind: 'event', text: '# 事件: 测试' })).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
