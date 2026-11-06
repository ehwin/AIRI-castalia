/**
 * 记忆库浏览器（app 内的「记忆库」页背后的读写层）。
 *
 * 为什么不再开网页：跨库浏览原来只有 3348 那个控制台（`viz/server.mjs` + 静态页），
 * app 只会 `shell.openExternal` 把浏览器打开。推广版不该要求用户再跑一个 Node 服务、
 * 再切一个浏览器标签。这里直接读 `<base>/<bank>/<project>/<partition>/memory.sqlite`。
 *
 * 只做三件用户真正会做的事：看、搜、改/删。跨库向量融合、建库删库、星图仍然只在控制台里 ——
 * 那一层是给开发用的，搬进来只会多一份要同步的实现。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { Database } from '@proj-airi/castalia-plugin/vendor/sqlite-shim'

export interface BankPartition {
  partition: string
  active: number
  total: number
}

export interface BankProject {
  project: string
  partitions: BankPartition[]
}

export interface BankTree {
  /** 库目录名（`memory-banks/<bank>`）。 */
  bank: string
  projects: BankProject[]
}

export interface BankRow {
  bank: string
  project: string
  partition: string
  id: string
  text: string
  memType: string
  characterId: string
  source: string
  createdAt: string
  updatedAt: string
  importance: number
  /** 这一行有没有向量。改过文本但没重嵌的行会显示「待重嵌」。 */
  hasVector: boolean
}

const SKIP_DIRS = new Set(['node_modules', '_backup', '_retired', '_exports'])
const MAX_LIMIT = 200

/** 库目录列表。只认 `<bank>/<project>/<partition>/memory.sqlite` 这种真实结构。 */
export function listBankTree(baseDir: string): BankTree[] {
  if (!existsSync(baseDir))
    return []
  const banks: BankTree[] = []
  for (const bank of safeReadDirs(baseDir)) {
    const bankDir = join(baseDir, bank)
    const projects: BankProject[] = []
    for (const project of safeReadDirs(bankDir)) {
      const projectDir = join(bankDir, project)
      const partitions: BankPartition[] = []
      for (const partition of safeReadDirs(projectDir)) {
        const file = join(projectDir, partition, 'memory.sqlite')
        if (!existsSync(file))
          continue
        const counts = countPartition(file)
        if (!counts)
          continue
        partitions.push({ partition, ...counts })
      }
      if (partitions.length > 0)
        projects.push({ project, partitions })
    }
    if (projects.length > 0)
      banks.push({ bank, projects })
  }
  return banks
}

function safeReadDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('_'))
      .map(entry => entry.name)
      .sort()
  }
  catch {
    return []
  }
}

function countPartition(file: string): { active: number, total: number } | undefined {
  try {
    const db = new Database(file, { readonly: true })
    try {
      // 一行 SQL 同时算活行和总行：分成两条查会让「软删的还在文件里」这件事在页面上消失。
      const row = db.prepare('SELECT SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM memory')
        .get() as { active?: number | null, total?: number } | undefined
      return { active: Number(row?.active ?? 0), total: Number(row?.total ?? 0) }
    }
    finally {
      db.close()
    }
  }
  catch {
    return undefined
  }
}

/** 解析成真实文件，并确认它没跑出 baseDir（`..` 或绝对路径注入）。 */
function partitionFile(baseDir: string, bank: string, project: string, partition: string): string | undefined {
  const root = resolve(baseDir)
  const file = resolve(root, bank, project, partition, 'memory.sqlite')
  const rel = relative(root, file)
  if (rel.startsWith('..') || rel.includes('..\\') || rel.includes('../'))
    return undefined
  return existsSync(file) ? file : undefined
}

function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, ch => `\\${ch}`)
  return `%${escaped}%`
}

export interface BankSearchOptions {
  baseDir: string
  bank?: string
  project?: string
  partition?: string
  query?: string
  limit?: number
}

/**
 * 在选定的范围内搜活跃行。
 *
 * 走 `LIKE` 而不是向量：这个页面的作用是「我记得她说过那句话，是哪个字」，字面匹配比
 * 语义召回更符合直觉；向量检索要按库加载嵌入配置，跨库各用各的模型，放在这里只会得出
 * 一串没法比较的分数。
 */
export function searchBank(options: BankSearchOptions): BankRow[] {
  const limit = Math.min(Math.max(Number(options.limit ?? 50) || 50, 1), MAX_LIMIT)
  const query = (options.query ?? '').trim()
  const rows: BankRow[] = []
  for (const bank of listBankTree(options.baseDir)) {
    if (options.bank && bank.bank !== options.bank)
      continue
    for (const project of bank.projects) {
      if (options.project && project.project !== options.project)
        continue
      for (const partition of project.partitions) {
        if (options.partition && partition.partition !== options.partition)
          continue
        const file = partitionFile(options.baseDir, bank.bank, project.project, partition.partition)
        if (!file)
          continue
        rows.push(...readPartition(file, {
          bank: bank.bank,
          project: project.project,
          partition: partition.partition,
          query,
          limit,
        }))
      }
    }
  }
  return rows
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, limit)
}

function readPartition(
  file: string,
  options: { bank: string, project: string, partition: string, query: string, limit: number },
): BankRow[] {
  try {
    const db = new Database(file, { readonly: true })
    try {
      const where = options.query ? 'WHERE is_active = 1 AND text LIKE ? ESCAPE \'\\\'' : 'WHERE is_active = 1'
      const params = options.query ? [likePattern(options.query), options.limit] : [options.limit]
      const rows = db.prepare(
        `SELECT rowid AS rowid, id, text, mem_type, character_id, source, created_at, updated_at, importance
         FROM memory ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
      ).all(...params) as Array<Record<string, unknown>>
      return rows.map(row => ({
        bank: options.bank,
        project: options.project,
        partition: options.partition,
        id: String(row.id ?? ''),
        text: String(row.text ?? ''),
        memType: String(row.mem_type ?? ''),
        characterId: String(row.character_id ?? ''),
        source: String(row.source ?? ''),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? ''),
        importance: Number(row.importance ?? 0),
        hasVector: hasVector(db, Number(row.rowid ?? 0)),
      }))
    }
    finally {
      db.close()
    }
  }
  catch {
    return []
  }
}

/** 读 shadow 表就够：`vec_memory` 本身要加载 sqlite-vec，这里只想知道「有没有」。 */
function hasVector(db: Database, rowid: number): boolean {
  if (!rowid)
    return false
  try {
    return Boolean(db.prepare('SELECT 1 AS hit FROM vec_memory_rowids WHERE rowid = ?').get(rowid))
  }
  catch {
    return false
  }
}

export interface BankRowTarget {
  baseDir: string
  bank: string
  project: string
  partition: string
  id: string
}

export interface BankWriteResult {
  ok: boolean
  error?: string
}

/** 改正文。旧的向量跟着失效，直接删掉让补嵌重新计算。 */
export function updateBankRow(target: BankRowTarget, text: string): BankWriteResult {
  const next = String(text ?? '').trim()
  if (!next)
    return { ok: false, error: 'empty text' }
  const file = partitionFile(target.baseDir, target.bank, target.project, target.partition)
  if (!file)
    return { ok: false, error: 'partition not found' }
  try {
    const db = new Database(file)
    try {
      const row = db.prepare('SELECT rowid AS rowid, is_active FROM memory WHERE id = ?').get(target.id) as { rowid?: number, is_active?: number } | undefined
      if (!row || Number(row.is_active) !== 1)
        return { ok: false, error: 'row not found' }
      db.prepare('UPDATE memory SET text = ?, updated_at = ?, embed_fail_count = 0 WHERE id = ?')
        .run(next, new Date().toISOString(), target.id)
      try {
        db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(Number(row.rowid ?? 0))
      }
      catch { /* 没有 vec 表 / 扩展没挂上：下次补嵌时按 rowid 缺失处理 */ }
      return { ok: true }
    }
    finally {
      db.close()
    }
  }
  catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/** 软删，并删掉它的向量（引擎的约定：删行先删向量）。 */
export function deleteBankRow(target: BankRowTarget): BankWriteResult {
  const file = partitionFile(target.baseDir, target.bank, target.project, target.partition)
  if (!file)
    return { ok: false, error: 'partition not found' }
  try {
    const db = new Database(file)
    try {
      const row = db.prepare('SELECT rowid AS rowid, is_active FROM memory WHERE id = ?').get(target.id) as { rowid?: number, is_active?: number } | undefined
      if (!row || Number(row.is_active) !== 1)
        return { ok: false, error: 'row not found' }
      db.prepare('UPDATE memory SET is_active = 0, updated_at = ? WHERE id = ?').run(new Date().toISOString(), target.id)
      try {
        db.prepare('DELETE FROM vec_memory WHERE rowid = ?').run(Number(row.rowid ?? 0))
      }
      catch { /* 同上 */ }
      return { ok: true }
    }
    finally {
      db.close()
    }
  }
  catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}
