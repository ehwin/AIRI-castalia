/**
 * sqlite-compat — 让这套控制台在两种运行环境里用同一个驱动。
 *
 * 独立跑（`node server.mjs`）时优先用 better-sqlite3：它快、API 全，本地早就装好了。
 * 被 AIRI 主进程拉起来时（`ELECTRON_RUN_AS_NODE=1`）不能再用它：那是 Electron 的 ABI，
 * 原生模块要重编，而 app 里已经有 `node:sqlite` 这条稳定路径（vec0.dll 随包发）。
 *
 * 两边用到的 API 只有 prepare / exec / transaction / pragma / close / loadExtension，
 * 所以这里补一层就这么点，不需要把整份 better-sqlite3 行为模拟出来。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let BetterSqlite = null;
try {
  // 只 require 成功不够：Electron 的 ABI 下它是「装得上、一用就炸」，
  // 所以真开一个内存库跑一条语句来验。
  const candidate = require('better-sqlite3');
  const probe = new candidate(':memory:');
  probe.exec('CREATE TABLE probe(x)');
  probe.close();
  BetterSqlite = candidate;
}
catch { /* 没装或 ABI 不匹配：走 node:sqlite */ }

class NodeSqliteDatabase {
  constructor(file, options = {}) {
    const { DatabaseSync } = require('node:sqlite');
    // `allowExtension` 必须显式打开：node:sqlite 默认拒绝 loadExtension，
    // 而拒绝是静默的——之后 `JOIN vec_memory` 只会报「no such module: vec0」。
    this._db = new DatabaseSync(file, {
      readOnly: !!options.readonly,
      allowExtension: true,
      allowBareNamedParameters: true,
    });
    this._depth = 0;
    this._file = file;
  }

  prepare(sql) {
    return this._db.prepare(sql);
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  /** better-sqlite3 的写法是 `db.pragma('busy_timeout = 5000')`。 */
  pragma(statement) {
    return this._db.exec(`PRAGMA ${statement}`);
  }

  /** 只支持外层事务：这几个路由里没有嵌套事务。 */
  transaction(fn) {
    return (...args) => {
      if (this._depth > 0)
        return fn(...args);
      this._db.exec('BEGIN');
      this._depth += 1;
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      }
      catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
      finally {
        this._depth -= 1;
      }
    };
  }

  loadExtension(file) {
    return this._db.loadExtension(file);
  }

  close() {
    return this._db.close();
  }
}

/**
 * 挂向量扩展。
 *
 * 顺序：环境变量（app 主进程会指到随包的 vec0.dll）→ `sqlite-vec` npm 包解析出来的
 * 平台二进制 → 什么都不挂。挂不上不抛错：这个控制台的搜索会退化成全表扫描，星图仍然能画。
 */
export function loadVec(db) {
  const candidates = [];
  if (process.env.CASTALIA_VEC_DLL)
    candidates.push(process.env.CASTALIA_VEC_DLL);
  try {
    const entry = require.resolve('sqlite-vec');
    const dir = dirname(entry);
    candidates.push(join(dir, 'vec0.dll'), join(dir, 'vec0.so'), join(dir, 'vec0.dylib'));
    const pkg = require.resolve('sqlite-vec-windows-x64');
    candidates.push(dirname(pkg));
  }
  catch { /* 没装 sqlite-vec：只有环境变量这条 */ }

  for (const candidate of candidates) {
    const file = candidate.endsWith('.dll') || candidate.endsWith('.so') || candidate.endsWith('.dylib')
      ? candidate
      : join(candidate, 'vec0.dll');
    if (!existsSync(file))
      continue;
    try {
      db.loadExtension(file);
      return true;
    }
    catch { /* 换下一个候选 */ }
  }
  return false;
}

export default BetterSqlite || NodeSqliteDatabase;
