import type { MemoryMcpClient } from './game-memory'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { config } from '../composables/config'
import { resetGameMemory } from './game-memory'
import { configureGameMemory, memoryActions, memoryTags } from './memory-actions'

function fakeClient(calls: Array<{ name: string, arguments: Record<string, unknown> }>): MemoryMcpClient {
  return {
    callTool: async (params) => {
      calls.push(params)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, id: 'row-0001', results: [{ id: '1', text: '# 地点: 主屋', category: 'mc:place' }] }) }] }
    },
    close: async () => {},
  }
}

function action(name: string) {
  const found = memoryActions.find(item => item.name === name)
  if (!found)
    throw new Error(`missing action ${name}`)
  return found
}

beforeEach(() => {
  config.bot = { ...config.bot, host: 'mc.example.net', port: 25565 }
})

afterEach(() => {
  resetGameMemory()
})

describe('memoryActions', () => {
  it('answers without throwing when no memory client is configured', async () => {
    resetGameMemory()
    const perform = action('remember').perform({} as never)

    await expect(perform('place', '# 地点: 主屋')).resolves.toContain('not configured')
    await expect(action('recallMemory').perform({} as never)('主屋')).resolves.toContain('not configured')
  })

  it('writes through the client with the world tags of this server', async () => {
    const calls: Array<{ name: string, arguments: Record<string, unknown> }> = []
    configureGameMemory({ url: 'http://127.0.0.1:3320/mcp', enabled: true, factory: async () => fakeClient(calls) })

    const result = await action('remember').perform({} as never)('place', '# 地点: 主屋 x 120 y 64 z -330', 0.9)

    expect(String(result)).toContain('remembered as place')
    expect(calls[0].name).toBe('memory_save')
    expect(calls[0].arguments).toMatchObject({ category: 'mc:place', importance: 0.9 })
    expect(calls[0].arguments.tags).toContain('server:mc.example.net_25565')
    expect(String((calls[0].arguments.tags as string[])[2])).toMatch(/^day:\d{4}-\d{2}-\d{2}$/)
  })

  it('prints recalled rows as the memory block', async () => {
    const calls: Array<{ name: string, arguments: Record<string, unknown> }> = []
    configureGameMemory({ url: 'http://127.0.0.1:3320/mcp', enabled: true, factory: async () => fakeClient(calls) })

    const result = await action('recallMemory').perform({} as never)('主屋在哪', 4)

    expect(String(result)).toContain('[MEMORY] 游戏记忆 · mc.example.net:25565')
    expect(String(result)).toContain('- [place] # 地点: 主屋')
    expect(calls[0].name).toBe('memory_search')
  })

  it('says nothing matched instead of inventing a place', async () => {
    configureGameMemory({
      url: 'http://127.0.0.1:3320/mcp',
      enabled: true,
      factory: async () => ({
        callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [] }) }] }),
        close: async () => {},
      }),
    })

    await expect(action('recallMemory').perform({} as never)('末地要塞')).resolves.toContain('no memory matched')
  })

  it('tags every row with the day and the server, and nothing else', () => {
    const tags = memoryTags(new Date(2026, 10, 6))

    expect(tags).toEqual(['mc', 'server:mc.example.net_25565', 'day:2026-11-06'])
  })
})
