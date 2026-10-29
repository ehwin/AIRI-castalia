// NOTICE: vendored from castalia/Castalia-Anima/src/version.ts (engine mirror).
// Copied so the memory engine can run inside the AIRI main process (node:sqlite shim,
// no better-sqlite3 ABI build, no child process). Sync with:
//   node packages/castalia-plugin/scripts/sync-engine.mjs
// 不要在这里改逻辑；改 castalia 那边再同步回来。
// @ts-nocheck —— 引擎源码按它自己的 tsconfig 校验；这里只做镜像，用上游 tsc + 本包单测兜底。
// 由 scripts/gen_version.mjs 从仓库根 VERSION 生成，不要手改。
export const VERSION = '1.28.8';
