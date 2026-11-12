#!/usr/bin/env node
/**
 * Anima 事件层的主机侧触发（2026-10-30）
 *
 * 为什么要有这个文件：事件摘要（daily_event）原来只在两个地方被触发 ——
 * AIRI 主进程的 maintain()（每 20h + 启动补跑）和引擎入口 index.ts 里的定时器。
 * 后者已经删掉：in-process 形态根本不加载 index.ts，那是第二份调度器。
 * 于是 bank airi 什么时候被整理，完全取决于 AIRI 开没开、maintain 轮没轮到。
 *
 * 调度归宿主，引擎只提供能力（这是本机一贯的分层）：
 *   - 本脚本只做三件事：读 castalia.config.json 找 variant=anima 的实例 →
 *     用 Anima 的**部署产物**（run/Castalia-Anima/dist）跑一次 runEventDigest → 记账。
 *   - 不改引擎、不驻留、跑完即退（和 castalia_guard.py 同一套路，由计划任务每 10 分钟叫一次）。
 *   - 里面再做两层闸：状态文件节流（默认 10 分钟一次，与计划任务同频）+ 引擎自己的"没有待整理的对话"
 *     提前返回（零 LLM 调用），所以空跑一次只有一次 node 启动的开销。
 *
 * 用法
 *   node anima_event_digest.mjs                 # 按节流跑一次
 *   node anima_event_digest.mjs --force         # 忽略节流
 *   node anima_event_digest.mjs --dry           # 只算不写
 *   node anima_event_digest.mjs --days 5        # 回看天数（默认 3）
 *   node anima_event_digest.mjs --bank airi     # 只跑某个实例
 *   node anima_event_digest.mjs --status        # 看节流状态，不动库
 */
import fs from 'node:fs'
import path from 'node:path'

import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = path.join(HERE, 'castalia.config.json')
const STATE_FILE = path.join(HERE, '.anima_event_digest.state.json')
const LOG_FILE = path.join(HERE, 'anima-event-digest.log')

const argv = process.argv.slice(2)
const has = name => argv.includes(`--${name}`)
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}

const MIN_INTERVAL_MIN = Number(opt('interval', process.env.ANIMA_EVENT_DIGEST_INTERVAL_MIN || 10)) || 10
const DAYS = Math.max(1, Math.min(Number(opt('days', 3)) || 3, 14))

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { return fallback }
}
function log(line) {
  const stamp = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`) }
  catch { /* 日志写不了也不影响整理 */ }
  console.log(line)
}

const cfg = readJson(CONFIG, null)
if (!cfg) {
  log('RESULT: 失败 — 读不到 castalia.config.json')
  process.exit(1)
}
const paths = cfg.paths || {}
const banksRoot = paths.banks || 'D:/castalia/memory-banks'
const animaRun = paths.anima || 'D:/castalia/run/Castalia-Anima'
// 只有 anima 变体的实例才有事件层（core 引擎的 dist 里没有 eventDigest.js）
const instances = (cfg.instances || []).filter(i => i.variant === 'anima')
const wanted = opt('bank', '')
const targets = wanted ? instances.filter(i => i.id === wanted || i.bank === wanted) : instances

if (has('status')) {
  const state = readJson(STATE_FILE, {})
  for (const i of instances) console.log(`${i.id} last=${state[i.id] || '(never)'}`)
  process.exit(0)
}
if (targets.length === 0) {
  log(`RESULT: 跳过 — 没有 anima 变体的实例${wanted ? `（--bank ${wanted}）` : ''}`)
  process.exit(0)
}
// 多实例时逐个另起进程：configLoader 把 bank 根写进进程级环境，同进程复用会串库
if (targets.length > 1) {
  let failed = 0
  for (const inst of targets) {
    const args = [fileURLToPath(import.meta.url), '--bank', inst.id, '--days', String(DAYS)]
    if (has('force'))
      args.push('--force')
    if (has('dry'))
      args.push('--dry')
    const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
    if (r.status !== 0)
      failed++
  }
  process.exit(failed ? 1 : 0)
}

const inst = targets[0]
const state = readJson(STATE_FILE, {})
const lastMs = state[inst.id] ? Date.parse(state[inst.id]) : 0
const ageMin = lastMs ? (Date.now() - lastMs) / 60000 : Infinity
if (!has('force') && ageMin < MIN_INTERVAL_MIN && !has('dry')) {
  // 静默跳过：计划任务每 10 分钟叫一次，没必要每次都写日志
  process.exit(0)
}

process.env.MEMORY_DB_DIR = `${banksRoot}/${inst.bank}`
process.env.MEMORY_CONFIG = `${banksRoot}/${inst.bank}/config.json`
process.env.CASTALIA_PROJECT = inst.project
process.env.CHAR_ID = inst.char
delete process.env.EMBED_MODE // 跟随 bank 配置（发布里是 api），别被调用方环境污染

const dist = f => pathToFileURL(path.join(animaRun, 'dist', f)).href
const startedAt = Date.now()

try {
  await import(dist('configLoader.js'))
  const { runEventDigest } = await import(dist('eventDigest.js'))
  const r = await runEventDigest({ project: inst.project, characterId: inst.char, days: DAYS, dryRun: has('dry') })
  const ms = Date.now() - startedAt
  const detail = `${inst.id} conversations=${r.conversations} events=${r.events} inserted=${r.inserted}`
    + ` updated=${r.updated} skipped=${r.skipped} errors=${r.errors.length}`
    + `${r.skippedReason ? ` (${r.skippedReason})` : ''} ${ms}ms${has('dry') ? ' [dry]' : ''}`
  if (!has('dry')) {
    state[inst.id] = new Date().toISOString()
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) }
    catch { /* 状态写不了下次还会跑，多花一次查询而已 */ }
  }
  if (r.errors.length > 0) {
    log(`RESULT: 有错误 — ${detail} :: ${r.errors.slice(0, 3).join(' | ')}`)
    process.exit(1)
  }
  // 没有待整理的对话属于正常空转，不写日志（每 10 分钟一条太吵）
  if (r.events === 0 && r.conversations === 0)
    process.exit(0)
  log(`RESULT: ${detail}`)
  process.exit(0)
}
catch (e) {
  log(`RESULT: 失败 — ${inst.id} ${String(e && e.message ? e.message : e).slice(0, 160)}`)
  process.exit(1)
}
