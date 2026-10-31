#!/usr/bin/env node
import process from 'node:process'

// NOTICE: 把 castalia 引擎源码同步进插件 vendor 目录。
// 用: node packages/castalia-plugin/scripts/sync-engine.mjs [--engine <src dir>]
// 做的事: 复制 .ts → 改写 better-sqlite3/sqlite-vec 导入 → 加 NOTICE 头 + @ts-nocheck →
//        跳过 MCP 入口(index.ts/fedServer.ts，插件不需要)。
// 幂等: 重复跑结果一致；改完跑 pnpm -F @proj-airi/castalia-plugin test:run 验证。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const args = process.argv.slice(2)
const engineIdx = args.indexOf('--engine')
// 源码三仓现在在 D:/AI/castalia（D:/system/AIRI/castalia 只剩兜旧 argv 的 junction）。
// 依次尝试：--engine 参数 → 旧 junction → 新树，选第一个真的存在且像引擎的目录。
function pickEngineSrc() {
  if (engineIdx >= 0)
    return resolve(args[engineIdx + 1])
  const candidates = [
    join(pkgRoot, '../../castalia/Castalia-Anima/src'),
    'D:/AI/castalia/Castalia-Anima/src',
  ]
  for (const candidate of candidates) {
    try {
      if (readdirSync(candidate).filter(f => f.endsWith('.ts')).length > 20)
        return candidate
    }
    catch { /* 试下一个 */ }
  }
  return candidates[0]
}

const engineSrc = pickEngineSrc()
const dest = join(pkgRoot, 'src/vendor/engine')

const SKIP = new Set(['index.ts', 'fedServer.ts'])

function header(file) {
  return [
    `// NOTICE: vendored from castalia/Castalia-Anima/src/${file} (engine mirror).`,
    '// Copied so the memory engine can run inside the AIRI main process (node:sqlite shim,',
    '// no better-sqlite3 ABI build, no child process). Sync with:',
    '//   node packages/castalia-plugin/scripts/sync-engine.mjs',
    '// 不要在这里改逻辑；改 castalia 那边再同步回来。',
    '// @ts-nocheck —— 引擎源码按它自己的 tsconfig 校验；这里只做镜像，用上游 tsc + 本包单测兜底。',
  ].join('\n')
}

function rewrite(source, depth = 0) {
  // 子目录（federation/）里的文件要多上跳一层才能到 vendor/sqlite-shim。
  const up = '../'.repeat(depth + 1)
  let s = source
  s = s.replace(/from 'better-sqlite3'/g, `from '${up}sqlite-shim'`)
  s = s.replace(/from "better-sqlite3"/g, `from "${up}sqlite-shim"`)
  s = s.replace(
    /import \* as sqliteVec from 'sqlite-vec'/g,
    `import { loadVecExtension as _loadVec } from '${up}sqlite-shim'\nconst sqliteVec = { load: (db: any) => _loadVec(db) }`,
  )
  return s
}

// ── 类型导入拆分 ─────────────────────────────────────────────────────────────
// why: AIRI 的 tsconfig 开了 verbatimModuleSyntax，rolldown 会把 `import { MemType }`
// 当值导入保留，而 memType.ts 里 MemType 只是 type → MISSING_EXPORT。
// 这里静态扫一遍导出类型，把纯类型名挪进 `import type { ... }`。
function collectTypeExports(dir) {
  const map = new Map()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts'))
      continue
    const text = readFileSync(join(dir, file), 'utf8')
    const names = new Set()
    for (const m of text.matchAll(/export\s+(?:interface|type)\s+(\w+)/g)) names.add(m[1])
    if (names.size > 0)
      map.set(file.replace(/\.ts$/, ''), names)
  }
  return map
}

function splitTypeImports(source, typeExports) {
  return source.replace(
    /import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g,
    (whole, names, spec) => {
      // 引擎内部统一用 './x.js' 写法（TS→JS 输出习惯），匹配表键要去掉 .js
      const key = spec.replace(/^\.\//, '').replace(/\.js$/, '')
      const types = typeExports.get(key)
      if (!types)
        return whole
      const valueParts = []
      const typeParts = []
      for (const raw of names.split(',')) {
        const name = raw.trim()
        if (!name)
          continue
        const bucket = types.has(name) ? typeParts : valueParts
        bucket.push(name)
      }
      if (typeParts.length === 0)
        return whole
      const lines = []
      if (valueParts.length > 0)
        lines.push(`import { ${valueParts.join(', ')} } from '${spec}'`)
      lines.push(`import type { ${typeParts.join(', ')} } from '${spec}'`)
      return lines.join('\n')
    },
  )
}

// 先把源读进内存再动目标：源目录不存在时上面会抛错，绝不能先删掉 vendor 目录
// —— 2026-10-29 实际踩过：源路径失效 + 先 rmSync，38 个 vendor 文件被清空，只能 git checkout 恢复。
const sources = readdirSync(engineSrc).filter(f => f.endsWith('.ts')).sort()
if (sources.length < 20)
  throw new Error(`[sync-engine] 源目录不像引擎（只找到 ${sources.length} 个 .ts）：${engineSrc}`)

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })

const typeExports = collectTypeExports(engineSrc)

let copied = 0
for (const file of sources) {
  if (!file.endsWith('.ts') || SKIP.has(file))
    continue
  const raw = readFileSync(join(engineSrc, file), 'utf8')
  writeFileSync(join(dest, file), `${header(file)}\n${splitTypeImports(rewrite(raw), typeExports)}`, 'utf8')
  copied += 1
}

// ── 引擎能力清单 → TS 常量（面板据此只画真实支持的参数）────────────────────────
// 引擎仓根有 tuning-support.json 就落成 src/vendor/engine/tuningSupport.ts；
// 没有（心智版完整 Anima）就写 null —— 面板退回 src/tuning.ts 的完整清单，行为与以前一致。
// 为什么不直接读 JSON：打包后 asar 里 fs 读 JSON 路径不可靠，而 TS 常量会被正常编译进 bundle。
{
  const engineRoot = resolve(engineSrc, '..')
  const manifestPath = join(engineRoot, 'tuning-support.json')
  let manifest = null
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF+/, ''))
    }
    catch (error) {
      throw new Error(`[sync-engine] tuning-support.json 解析失败（${manifestPath}）：${error.message}`)
    }
    if (!manifest || typeof manifest !== 'object' || typeof manifest.groups !== 'object')
      throw new Error(`[sync-engine] tuning-support.json 缺 groups（${manifestPath}）`)
  }
  const body = [
    '// NOTICE: 由 scripts/sync-engine.mjs 从引擎仓根的 tuning-support.json 生成，不要手改。',
    manifest
      ? `// 引擎：${manifest.engine} / 变体：${manifest.variant} / 版本：${manifest.engine_version ?? '?'}`
      : '// 当前引擎没有声明清单（心智版）→ 面板退回 src/tuning.ts 的完整清单。',
    '// 类型定义在 src/engineTuning.ts。',
    'import type { EngineTuningManifest } from \'../../engineTuning\'',
    '',
    `export const TUNING_SUPPORT: EngineTuningManifest | null = ${manifest ? JSON.stringify(manifest, null, 2) : 'null'}`,
    '',
  ].join('\n')
  writeFileSync(join(dest, 'tuningSupport.ts'), body, 'utf8')
  console.info(`[sync-engine] tuning-support: ${manifest ? `${manifest.variant} (${Object.values(manifest.groups).flat().length} keys)` : 'none (fallback to full list)'}`)
}

// 子目录也要镜像：reflectAll.ts 引用了 './federation/index.js'，只复制扁平文件会留断链。
// 目录里的文件多一层，better-sqlite3 → ../../sqlite-shim。
const SUBDIRS = ['federation']
for (const sub of SUBDIRS) {
  const from = join(engineSrc, sub)
  if (!existsSync(from))
    continue
  const subSources = readdirSync(from).filter(f => f.endsWith('.ts')).sort()
  if (subSources.length === 0)
    continue
  const subDest = join(dest, sub)
  mkdirSync(subDest, { recursive: true })
  const subTypeExports = collectTypeExports(from)
  for (const file of subSources) {
    const raw = readFileSync(join(from, file), 'utf8')
    writeFileSync(
      join(subDest, file),
      `${header(`${sub}/${file}`)}\n${splitTypeImports(rewrite(raw, 1), subTypeExports)}`,
      'utf8',
    )
    copied += 1
  }
}
console.info(`synced ${copied} files from ${engineSrc} -> ${dest}`)
