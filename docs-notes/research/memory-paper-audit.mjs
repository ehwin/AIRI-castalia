// Read-only inventory and controlled quality-gate probes. Never prints memory text.
// Usage: node memory-paper-audit.mjs [repo] [banks] [output.json]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(process.argv[2] || 'D:/AI/castalia/Castalia-Anima');
const banks = path.resolve(process.argv[3] || 'D:/castalia/memory-banks');
const output = path.resolve(process.argv[4] || fileURLToPath(new URL('./memory-paper-audit-results.json', import.meta.url)));
const require = createRequire(path.join(repo, 'package.json'));
const Database = require('better-sqlite3');
const files = [], skipped = [];
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (/backup|snapshot|\.git|node_modules/i.test(ent.name)) { skipped.push(path.relative(banks, file)); continue; }
      walk(file);
    } else if (ent.isFile() && ent.name === 'memory.sqlite') files.push(file);
  }
}
walk(banks);
const partitions = [];
for (const file of files.sort()) {
  const entry = { path: path.relative(banks, file).replaceAll('\\', '/') };
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const cols = table => db.prepare(`PRAGMA table_info("${table}")`).all().map(r => r.name);
    if (tables.has('memory')) {
      entry.memoryColumns = cols('memory');
      entry.memory = db.prepare(`SELECT COUNT(*) AS rows,
        SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active,
        MIN(datetime(created_at)) AS firstCreated, MAX(datetime(created_at)) AS lastCreated,
        COUNT(DISTINCT date(created_at)) AS createdDays FROM memory`).get();
      entry.sources = db.prepare(`SELECT COALESCE(source,'<null>') AS source, COUNT(*) AS rows,
        SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active,
        MIN(datetime(created_at)) AS firstCreated, MAX(datetime(created_at)) AS lastCreated,
        COUNT(DISTINCT date(created_at)) AS createdDays FROM memory GROUP BY source ORDER BY rows DESC`).all();
      entry.roles = db.prepare('SELECT character_id, COUNT(*) AS rows FROM memory GROUP BY character_id').all();
      entry.accessCounts = db.prepare(`SELECT MAX(accessed_count) AS maxAccess,
        SUM(CASE WHEN accessed_count>=100 THEN 1 ELSE 0 END) AS rowsAtLeast100 FROM memory`).get();
    }
    for (const [table, time] of [['psyche_events','at'],['memory_access_log','accessed_at']]) {
      if (!tables.has(table)) { entry[table] = null; continue; }
      const timeExpr = `CASE WHEN typeof(${time}) IN ('integer','real') THEN datetime(${time}/1000.0,'unixepoch') ELSE datetime(${time}) END`;
      entry[table] = { columns: cols(table), ...db.prepare(`SELECT COUNT(*) AS rows,
        MIN(${timeExpr}) AS firstAt, MAX(${timeExpr}) AS lastAt,
        COUNT(DISTINCT date(${timeExpr})) AS days FROM ${table}`).get() };
      if (table === 'memory_access_log' && entry[table].columns.includes('channel')) {
        entry[table].channels = db.prepare('SELECT channel, COUNT(*) AS rows FROM memory_access_log GROUP BY channel ORDER BY rows DESC').all();
      }
    }
    for (const table of ['psyche_state','self_cycle_runs']) {
      entry[table] = tables.has(table) ? { rows: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, columns: cols(table) } : null;
    }
    db.exec('ROLLBACK');
  } catch (error) { entry.error = error.message; }
  finally { db?.close(); }
  partitions.push(entry);
}

// Use the current TypeScript source, transpiled in memory, without rebuilding dist.
const ts = require('typescript');
const qualityPath = path.join(repo, 'src/insightQuality.ts');
const qualitySource = fs.readFileSync(qualityPath, 'utf8');
const js = ts.transpileModule(qualitySource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { evaluateInsight } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const sources = [{ id: 'synthetic-1', text: '用户明确表示：我只喝无糖咖啡，不接受加糖。' }];
const probes = [
  { name: 'supported-rule', text: '以后提供咖啡必须无糖，因为用户不接受加糖。', evidence: '我只喝无糖咖啡，不接受加糖。', expectedClaimSupported: true },
  { name: 'reversed-preference-real-quote', text: '以后必须给用户的咖啡加糖，因为用户最喜欢甜味。', evidence: '我只喝无糖咖啡，不接受加糖。', expectedClaimSupported: false },
  { name: 'unsupported-cause-real-quote', text: '用户不接受加糖，因为他患有严重糖尿病，所以必须进行胰岛素治疗。', evidence: '我只喝无糖咖啡，不接受加糖。', expectedClaimSupported: false },
  { name: 'missing-quote', text: '以后必须给用户的咖啡加糖，因为用户最喜欢甜味。', expectedClaimSupported: false },
  { name: 'fabricated-quote-control', text: '以后必须给用户的咖啡加糖，因为用户最喜欢甜味。', evidence: '用户说自己每天加三勺糖。', expectedClaimSupported: false },
].map(probe => ({ ...probe, verdict: evaluateInsight({ ...probe, sources }) }));
const byBank = {};
for (const p of partitions) {
  const bank = p.path.split('/')[0];
  const b = byBank[bank] ||= { partitions: 0, rows: 0, active: 0, conversationRows: 0, psycheEventRows: 0, accessLogRows: 0 };
  b.partitions++;
  b.rows += p.memory?.rows || 0; b.active += p.memory?.active || 0;
  b.conversationRows += p.sources?.find(s => s.source === 'conversation_log')?.rows || 0;
  b.psycheEventRows += p.psyche_events?.rows || 0;
  b.accessLogRows += p.memory_access_log?.rows || 0;
}
const result = {
  at: new Date().toISOString(), repo, banks,
  method: 'Per-file read-only SQLite transaction; backups excluded; bank totals are stored rows, not deduplicated observations; no raw memory text exported.',
  qualitySourceSha256: crypto.createHash('sha256').update(qualitySource).digest('hex'),
  skipped, byBank, partitions, syntheticQualityProbes: probes,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, at: result.at, skipped, byBank,
  airiPartitions: partitions.filter(p => p.path.startsWith('airi/')).map(p => ({ path: p.path, memory: p.memory, sources: p.sources, psycheEvents: p.psyche_events, channels: p.memory_access_log?.channels })),
  qualityProbes: probes.map(p => ({ name: p.name, expectedClaimSupported: p.expectedClaimSupported, verdict: p.verdict })),
  errors: partitions.filter(p => p.error).map(p => ({ path: p.path, error: p.error })),
}, null, 2));
