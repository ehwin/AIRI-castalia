// Controlled integration probe: transpile CURRENT source into an isolated temp
// package, create a fresh bank, disable embedding, and call the real search API.
// No production data is opened. Temporary runtime is retained for inspection.
// Usage: node memory-feedback-probe.mjs [repo] [output.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repo = path.resolve(process.argv[2] || 'D:/AI/castalia/Castalia-Anima');
const output = path.resolve(process.argv[3] || fileURLToPath(new URL('./memory-feedback-probe-results.json', import.meta.url)));
const require = createRequire(path.join(repo, 'package.json'));
const ts = require('typescript');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'castalia-paper-feedback-'));
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.symlinkSync(path.join(repo, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
const hashes = {};
function compile(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const sourcePath = path.join(from, ent.name);
    if (ent.isDirectory()) { compile(sourcePath, path.join(to, ent.name)); continue; }
    if (!ent.name.endsWith('.ts') || ent.name.endsWith('.d.ts')) continue;
    const source = fs.readFileSync(sourcePath, 'utf8');
    hashes[path.relative(repo, sourcePath).replaceAll('\\', '/')] = crypto.createHash('sha256').update(source).digest('hex');
    const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, esModuleInterop: true } });
    fs.writeFileSync(path.join(to, ent.name.replace(/\.ts$/, '.js')), result.outputText);
  }
}
compile(path.join(repo, 'src'), path.join(tmp, 'runtime'));
process.env.MEMORY_DB_DIR = path.join(tmp, 'bank');
delete process.env.MEMORY_DB_PATH;
process.env.MEMORY_CONFIG = path.join(tmp, 'missing-config.json');
process.env.CASTALIA_PROJECT = 'audit';
process.env.CHAR_ID = 'audit';
process.env.EMBED_MODE = 'none';
process.env.CONSOLIDATE_AUTO_ON_START = '0';
process.env.REFLECT_INTERVAL_HOURS = '0';
process.env.HEALTH_PORT = '0';
for (const name of ['WEIGHT_CONSISTENCY','WEIGHT_EMOTION','WEIGHT_TIME','WEIGHT_DEVIATION','SEARCH_MIN_SCORE']) delete process.env[name];
const load = name => import(pathToFileURL(path.join(tmp, 'runtime', name + '.js')).href);
const { DatabaseManager } = await load('db');
const { searchMemory } = await load('search');
const { shouldReinforce } = await load('emotionalRanking');
const db = DatabaseManager.getInstance('audit', 'general');
const old = new Date(Date.now() - 30 * 86400000).toISOString();
db.prepare(`INSERT INTO memory (id,text,project,type,mem_type,category,tags,importance,
  character_id,source,created_at,updated_at,last_accessed_at,accessed_count)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'probe-memory', '咖啡偏好记录：用户明确表示只接受无糖咖啡，不能加糖。',
  'audit', 'episodic', 'general', 'conversation', '[]', 0.5,
  'audit', 'conversation_log', old, old, old, 0,
);
const opts = { query: '咖啡', project: 'audit', characterId: 'audit', topK: 1, minScore: 0 };
const snapshot = () => ({
  ...db.prepare('SELECT accessed_count,last_accessed_at,status FROM memory WHERE id=?').get('probe-memory'),
  logs: db.prepare('SELECT channel,COUNT(*) AS rows FROM memory_access_log GROUP BY channel').all(),
});
const reset = tags => {
  db.prepare('UPDATE memory SET accessed_count=0,last_accessed_at=?,tags=? WHERE id=?').run(old, tags, 'probe-memory');
  db.exec('DELETE FROM memory_access_log');
};
const before = snapshot();
const readOnlyHit = (await searchMemory({ ...opts, countAccess: false }))[0];
await searchMemory({ ...opts, countAccess: false });
const afterReadOnly = snapshot();
const diagnosticHit = (await searchMemory({ ...opts, accessChannel: 'diagnostic' }))[0];
const afterDiagnostic = snapshot();
const nextHit = (await searchMemory({ ...opts, countAccess: false }))[0];
reset('["咖啡"]');
await searchMemory({ ...opts, accessChannel: 'explicit_recall' });
const afterTagRecall = snapshot();
const result = {
  at: new Date().toISOString(), repo, temporaryRuntime: tmp,
  method: 'Current source transpiled to temp; fresh SQLite bank; EMBED_MODE=none; one synthetic memory, no model calls; snapshots and score changes demonstrate mechanism, not prevalence or answer quality.',
  sourceHashes: hashes,
  readOnly: { before, after: afterReadOnly, unchanged: JSON.stringify(before) === JSON.stringify(afterReadOnly), hitCount: readOnlyHit ? 1 : 0 },
  diagnostic: { shouldReinforce: shouldReinforce('diagnostic'), after: afterDiagnostic,
    scoreBefore: readOnlyHit?.score, scoreDuring: diagnosticHit?.score, scoreAfter: nextHit?.score,
    similarityBefore: readOnlyHit?.similarity, similarityAfter: nextHit?.similarity,
    salienceBefore: readOnlyHit?.salience, salienceAfter: nextHit?.salience },
  tagFastPath: { requestedChannel: 'explicit_recall', after: afterTagRecall },
};
const checks = {
  readOnlyFindsMemory: result.readOnly.hitCount === 1,
  readOnlyDoesNotWrite: result.readOnly.unchanged,
  diagnosticIsNotAnAuthorizedReinforcementChannel: result.diagnostic.shouldReinforce === false,
  diagnosticNeverthelessIncrementsCount: afterDiagnostic.accessed_count === 1,
  diagnosticNeverthelessWritesLog: afterDiagnostic.logs.some(r => r.channel === 'diagnostic' && r.rows === 1),
  subsequentScoreIncreasesAtSameSimilarity: nextHit?.score > readOnlyHit?.score && nextHit?.similarity === readOnlyHit?.similarity,
  tagPathLosesRequestedChannel: afterTagRecall.logs.some(r => r.channel === 'search' && r.rows === 1),
};
result.checks = checks;
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, ...result, sourceHashes: undefined }, null, 2));
db.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
