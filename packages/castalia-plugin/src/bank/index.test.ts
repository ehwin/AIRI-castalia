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

  it('tags VAD on the write path (no Ollama in-process)', async () => {
    // 进程内形态没有 autoProcess/digest 周期,所以 bank.save 自己补一次离线词表 VAD。
    // 这条测试盯的是"情感数据真的落库",不是词表精度。
    const saved = await bank.save({
      text: '她跟我说分手，我很难过',
      project: 'testproj',
      memType: 'general',
      characterId: 'airi',
      skipEmbed: true,
    })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const row = db.prepare('SELECT vad_valence, vad_arousal, emotional_impact FROM memory WHERE id = ?').get(saved.id) as any
    db.close()
    expect(row?.vad_valence).toBeLessThan(0)
    expect(Number(row?.emotional_impact)).toBeGreaterThan(0)
  })

  it('reconciles sessions: dry-run by default, soft-delete only anchored rows', async () => {
    // 写两条带 session 锚点的记忆 + 一条无锚点
    const a = await bank.save({ text: '会话 A 里的事', project: 'testproj', characterId: 'airi', sessionId: 'sess-a', skipEmbed: true })
    const b = await bank.save({ text: '会话 B 里的事', project: 'testproj', characterId: 'airi', sessionId: 'sess-b', skipEmbed: true })
    await bank.save({ text: '手写 lore,无会话锚点', project: 'testproj', characterId: 'airi', skipEmbed: true })

    const dry = bank.orphanSessions({ aliveSessionIds: ['sess-a'] })
    expect(dry.some(r => r.orphans > 0)).toBe(true)
    expect(dry.every(r => r.orphaned === 0)).toBe(true)   // 默认 dryRun

    const applied = bank.orphanSessions({ aliveSessionIds: ['sess-a'], dryRun: false })
    expect(applied.some(r => r.orphaned > 0)).toBe(true)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'testproj', 'general', 'memory.sqlite'))
    const rows = db.prepare('SELECT id, is_active FROM memory WHERE id IN (?,?)').all(a.id, b.id) as any[]
    db.close()
    const byId = new Map(rows.map(r => [r.id, Number(r.is_active)]))
    expect(byId.get(a.id)).toBe(1)   // 活会话不动
    expect(byId.get(b.id)).toBe(0)   // 孤儿被软删
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
