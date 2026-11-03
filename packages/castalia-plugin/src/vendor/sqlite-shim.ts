// NOTICE: better-sqlite3 → node:sqlite 适配层。
// why: AIRI 主进程跑在 Electron 43（NODE_MODULE_VERSION 148），引擎自带的
//      better-sqlite3 是按 CastaliaNode 的 137 编的，在 Electron 里打不开
//      （实测 "compiled against a different Node.js version"）。而 Electron 内置的
//      node:sqlite 是随二进制一起编的，没有 ABI 问题，且能 loadExtension 挂 sqlite-vec。
// 覆盖范围: 只实现引擎实际用到的 API（prepare/get/all/run · exec · pragma · transaction ·
//          close · loadExtension · 命名参数 @name）。多了会假装支持，少了会静默出错。
// 移除条件: better-sqlite3 换成 Node-API 版本，或 Electron 侧不再需要进程内嵌入。
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const VEC_CANDIDATES = [
  process.env.CASTALIA_VEC_EXT,
  // 运行库优先：AIRI 只依赖 D:/castalia/run（/d/system/AIRI/castalia 是指向它的 junction）。
  // 2026-11-02: 删掉 D:/AI/castalia（源码仓）兜底 —— 那条路会让 AIRI 在运行库缺件时
  // 静默回落到源码层，等于把源码树变成隐式依赖。
  'D:/castalia/run/Castalia-Anima/node_modules/sqlite-vec-windows-x64/vec0.dll',
  'D:/castalia/run/Castalia/node_modules/sqlite-vec-windows-x64/vec0.dll',
].filter(Boolean) as string[]

export function resolveVecExtension(): string | undefined {
  return VEC_CANDIDATES.find(p => existsSync(p))
}

type Params = unknown[]

interface Row {
  [key: string]: unknown
}

class ShimStatement {
  constructor(private readonly stmt: any) {}

  get(...params: Params): Row | undefined {
    return this.stmt.get(...normalize(params))
  }

  all(...params: Params): Row[] {
    return this.stmt.all(...normalize(params))
  }

  run(...params: Params): { changes: number, lastInsertRowid: number | bigint } {
    const r = this.stmt.run(...normalize(params))
    return { changes: Number(r.changes ?? 0), lastInsertRowid: r.lastInsertRowid ?? 0 }
  }
}

// better-sqlite3 支持把对象直接摊开做命名参数；node:sqlite 需要 allowBareNamedParameters。
function normalize(params: Params): Params {
  return params
}

type TxFn = (...args: unknown[]) => unknown

export interface ShimOptions {
  readonly?: boolean
  fileMustExist?: boolean
  timeout?: number
}

let savepointDepth = 0

export class Database {
  private readonly inner: DatabaseSync
  private vecLoaded = false
  private closed = false

  constructor(file: string, options: ShimOptions = {}) {
    this.inner = new DatabaseSync(file, {
      readOnly: !!options.readonly,
      allowExtension: true,
      allowBareNamedParameters: true,
    } as any)
    if (!options.readonly)
      this.tryLoadVec()
  }

  get open(): boolean {
    return !this.closed
  }

  get name(): string {
    return String((this.inner as any).location?.() ?? '')
  }

  private tryLoadVec(): void {
    if (this.vecLoaded)
      return
    const ext = resolveVecExtension()
    if (!ext)
      return
    try {
      this.inner.loadExtension(ext)
      this.vecLoaded = true
    }
    catch {
      // 已加载过或表不存在时忽略；真正需要向量时会在查询处暴露
    }
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.inner.prepare(sql))
  }

  exec(sql: string): this {
    this.inner.exec(sql)
    return this
  }

  pragma(statement: string): unknown {
    try {
      return this.inner.prepare(`PRAGMA ${statement}`).all()
    }
    catch {
      this.inner.exec(`PRAGMA ${statement}`)
      return []
    }
  }

  loadExtension(path: string): this {
    this.inner.loadExtension(path)
    this.vecLoaded = true
    return this
  }

  transaction(fn: TxFn): TxFn {
    const self = this
    return function transactionWrapper(this: unknown, ...args: unknown[]) {
      const savepoint = `sp_${savepointDepth++}`
      const nested = savepointDepth > 1
      self.inner.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN')
      try {
        const result = fn.apply(this, args)
        self.inner.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
        return result
      }
      catch (error) {
        try {
          self.inner.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
        }
        catch {}
        throw error
      }
      finally {
        savepointDepth = Math.max(0, savepointDepth - 1)
      }
    }
  }

  close(): void {
    if (this.closed)
      return
    this.closed = true
    try {
      this.inner.close()
    }
    catch {}
  }
}

/**
 * 引擎源码里用 `Database.Database` 作类型（better-sqlite3 的命名空间写法），
 * 这里用 class + namespace 合并补上，避免改调用方。
 */
export namespace Database {
  export type Database = DatabaseConnection
  export type Statement = ShimStatement
}

export interface DatabaseConnection {
  prepare: (sql: string) => ShimStatement
  exec: (sql: string) => unknown
  pragma: (statement: string) => unknown
  transaction: (fn: TxFn) => TxFn
  close: () => void
  loadExtension?: (p: string) => unknown
}

export function loadVecExtension(db: { loadExtension?: (p: string) => unknown }): void {
  const ext = resolveVecExtension()
  if (ext && db.loadExtension)
    db.loadExtension(ext)
}

export default Database
