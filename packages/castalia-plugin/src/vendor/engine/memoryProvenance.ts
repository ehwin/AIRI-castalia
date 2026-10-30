// NOTICE: vendored from castalia/Castalia-Anima/src/memoryProvenance.ts (engine mirror).
// Copied so the memory engine can run inside the AIRI main process (node:sqlite shim,
// no better-sqlite3 ABI build, no child process). Sync with:
//   node packages/castalia-plugin/scripts/sync-engine.mjs
// 不要在这里改逻辑；改 castalia 那边再同步回来。
// @ts-nocheck —— 引擎源码按它自己的 tsconfig 校验；这里只做镜像，用上游 tsc + 本包单测兜底。
/** Sources produced by the runtime itself rather than by an external or user interaction. */
export const DERIVED_MEMORY_SOURCES = ['agent_diary', 'agent_state'] as const;

export type DerivedMemorySource = typeof DERIVED_MEMORY_SOURCES[number];

export function isDerivedMemorySource(source: unknown): boolean {
  return DERIVED_MEMORY_SOURCES.includes(String(source || '') as DerivedMemorySource);
}

/** SQL predicate for public memory paths. NULL/empty sources remain ordinary legacy evidence. */
export function publicMemorySourceSql(alias = ''): string {
  const column = alias ? `${alias}.source` : 'source';
  return `COALESCE(${column}, '') NOT IN ('agent_diary', 'agent_state')`;
}

/** SQL predicate for paths that may explicitly browse diary rows but never state snapshots. */
export function memorySourceWithoutStateSql(alias = ''): string {
  const column = alias ? `${alias}.source` : 'source';
  return `COALESCE(${column}, '') <> 'agent_state'`;
}
