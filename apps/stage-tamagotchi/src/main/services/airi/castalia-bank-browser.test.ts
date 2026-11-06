import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from '@proj-airi/castalia-plugin/vendor/sqlite-shim'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deleteBankRow, listBankTree, searchBank, updateBankRow } from './castalia-bank-browser'

let baseDir = ''

function openPartition(bank: string, project: string, partition: string): Database {
  const dir = join(baseDir, bank, project, partition)
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, 'memory.sqlite'))
  db.exec(`CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    mem_type TEXT,
    character_id TEXT,
    source TEXT,
    is_active INTEGER DEFAULT 1,
    importance REAL DEFAULT 0.5,
    embed_fail_count INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  )`)
  return db
}

function insert(db: Database, id: string, text: string, updatedAt: string) {
  db.prepare(`INSERT INTO memory (id, text, mem_type, character_id, source, is_active, created_at, updated_at)
    VALUES (?, ?, 'general', 'airi', 'conversation_log', 1, ?, ?)`).run(id, text, updatedAt, updatedAt)
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'bank-browser-'))
  const db = openPartition('airi', 'airi', 'general')
  insert(db, 'm1', '她说过：晚上八点吃饭', '2026-11-01T10:00:00Z')
  insert(db, 'm2', '用户喜欢喝咖啡 100%', '2026-11-02T10:00:00Z')
  insert(db, 'm3', '旧的测试行', '2026-11-03T10:00:00Z')
  db.prepare('UPDATE memory SET is_active = 0 WHERE id = ?').run('m3')
  db.close()

  const diary = openPartition('airi', 'airi', 'diary')
  insert(diary, 'd1', '# diary-2026-11-01\n\n她今天很累', '2026-11-04T10:00:00Z')
  diary.close()
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('listBankTree', () => {
  it('lists bank → project → partition with active and total counts', () => {
    const tree = listBankTree(baseDir)

    expect(tree).toHaveLength(1)
    expect(tree[0].bank).toBe('airi')
    expect(tree[0].projects[0].project).toBe('airi')
    const general = tree[0].projects[0].partitions.find(p => p.partition === 'general')
    // 一条软删行仍然算进 total：页面上「库里其实还有多少行」不能因为软删就消失。
    expect(general).toMatchObject({ active: 2, total: 3 })
  })

  it('returns nothing for a missing base dir', () => {
    expect(listBankTree(join(baseDir, 'nope'))).toEqual([])
  })
})

describe('searchBank', () => {
  it('finds rows by text and skips soft-deleted ones', () => {
    const rows = searchBank({ baseDir, query: '咖啡' })

    expect(rows.map(row => row.id)).toEqual(['m2'])
  })

  it('searches every partition when none is chosen', () => {
    const rows = searchBank({ baseDir, query: '她' })

    expect(rows.map(row => row.id).sort()).toEqual(['d1', 'm1'])
  })

  it('treats % and _ as literal characters', () => {
    expect(searchBank({ baseDir, query: '%' }).map(row => row.id)).toEqual(['m2'])
    expect(searchBank({ baseDir, query: '_' })).toEqual([])
  })

  it('orders newest first and respects the limit', () => {
    const rows = searchBank({ baseDir, limit: 1 })

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('d1')
  })

  it('caps the limit instead of trusting the caller', () => {
    expect(searchBank({ baseDir, limit: 10_000 }).length).toBeLessThanOrEqual(200)
  })
})

describe('writes', () => {
  it('updates the text and bumps updated_at', () => {
    const result = updateBankRow({ baseDir, bank: 'airi', project: 'airi', partition: 'general', id: 'm1' }, '她说过：晚上九点吃饭')

    expect(result.ok).toBe(true)
    const rows = searchBank({ baseDir, query: '九点' })
    expect(rows.map(row => row.id)).toEqual(['m1'])
    expect(rows[0].updatedAt > '2026-11-01T10:00:00Z').toBe(true)
  })

  it('refuses empty text and unknown rows', () => {
    expect(updateBankRow({ baseDir, bank: 'airi', project: 'airi', partition: 'general', id: 'm1' }, '  ').ok).toBe(false)
    expect(deleteBankRow({ baseDir, bank: 'airi', project: 'airi', partition: 'general', id: 'nope' }).ok).toBe(false)
  })

  it('soft deletes so the row leaves search but stays in the file', () => {
    const result = deleteBankRow({ baseDir, bank: 'airi', project: 'airi', partition: 'general', id: 'm2' })

    expect(result.ok).toBe(true)
    expect(searchBank({ baseDir, query: '咖啡' })).toEqual([])
    const general = listBankTree(baseDir)[0].projects[0].partitions.find(p => p.partition === 'general')
    expect(general).toMatchObject({ active: 1, total: 3 })
  })

  it('refuses a bank name that walks out of the base dir', () => {
    const result = deleteBankRow({ baseDir, bank: '..', project: 'airi', partition: 'general', id: 'm1' })

    expect(result.ok).toBe(false)
  })
})
