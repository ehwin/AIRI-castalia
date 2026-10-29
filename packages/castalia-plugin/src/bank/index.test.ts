import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openBank } from './index'

// 运行环境: Node 24 的 node:sqlite + vec0.dll（Electron 主进程同样可用，另见 .cache 下的探针）。
// 注意: 本文件**只能**通过 openBank 触达引擎 —— 引擎在求值时读 process.env，
// 静态 import 任何 vendor/engine 模块都会让 env 在 openBank 之前定型（踩过）。

let dir: string
let bank: Awaited<ReturnType<typeof openBank>>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'castalia-bank-'))
  bank = await openBank({ bankDir: dir, project: 'testproj', charId: 'airi', allowNoConfig: true })
})

afterAll(() => {
  bank?.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('in-process bank', () => {
  it('writes and reads back a memory', async () => {
    const saved = await bank.save({
      text: '记忆体插件化：进程内跑引擎，不再走子进程或 HTTP。',
      project: 'testproj',
      memType: 'general',
      characterId: 'airi',
      skipEmbed: true,
    })
    expect(saved.id).toBeTruthy()

    const recent = bank.recent(5)
    expect(recent.length).toBeGreaterThan(0)
    expect(recent.some(r => String(r.text).includes('插件化'))).toBe(true)
  })

  it('finds it back by lexical search', async () => {
    const hits = await bank.search({ query: '进程内跑引擎', project: 'testproj', characterId: 'airi', topK: 5, minScore: 0 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(h => String(h.text ?? '').includes('插件化'))).toBe(true)
  })

  it('reports stats through the same shim', () => {
    const stats = bank.stats()
    const general = stats.find(s => s.memType === 'general')
    expect(general?.active).toBeGreaterThan(0)
  })

  it('forgets and the row stops being active', async () => {
    const saved = await bank.save({
      text: '临时记忆：这条会被删掉。',
      project: 'testproj',
      memType: 'general',
      characterId: 'airi',
      skipEmbed: true,
    })
    bank.forget(saved.id)
    const still = bank.recent(20).some(r => r.id === saved.id)
    expect(still).toBe(false)
  })
})

describe('store tools (memory_store_* port)', () => {
  it('saves, lists, and forgets by index name', async () => {
    const saved = await bank.saveStore({
      name: 'test-entry',
      description: '一句话索引',
      body: '正文内容，用于验证 store 往返。',
      characterId: 'airi',
    })
    expect(saved.id).toBeTruthy()

    const listed = bank.listStore({ characterId: 'airi', source: 'airi' })
    const found = listed.records.find(r => r.name === 'test-entry')
    expect(found).toBeTruthy()
    expect(found?.description).toBe('一句话索引')
    expect(found?.body).toContain('正文内容')

    const again = await bank.saveStore({
      name: 'test-entry',
      description: '改过的索引',
      body: '改过的正文。',
      characterId: 'airi',
    })
    expect(again.updated).toBe(true)
    expect(again.id).toBe(saved.id)

    const forgotten = bank.forgetStore({ name: 'test-entry', characterId: 'airi' })
    expect(forgotten.deleted).toBe(true)
    const after = bank.listStore({ characterId: 'airi', source: 'airi' })
    expect(after.records.find(r => r.name === 'test-entry')).toBeUndefined()
  })
})
