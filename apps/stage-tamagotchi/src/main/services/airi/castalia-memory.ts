import type { createContext } from '@moeru/eventa/adapters/electron/main'

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineInvokeHandler } from '@moeru/eventa'
import { createCastaliaMemoryRepository } from '@proj-airi/castalia-plugin/memory'
import { app } from 'electron'

import { castaliaFullMembers, castaliaFullSearch, castaliaMemoryForget, castaliaMemoryIngest, castaliaMemoryList, castaliaMemoryMaintain, castaliaMemoryPsyche, castaliaMemoryRecall, castaliaMemorySave, castaliaMemorySelfCycle, castaliaOpenConsole, castaliaTuningGet, castaliaTuningSave } from '../../../shared/eventa/castalia-memory'
import { openCastaliaConsole } from './castalia-console'
import type { CastaliaEngineMemory } from './castalia-engine'

import { createCastaliaEngineMemory, resolveCastaliaEngineOptions } from './castalia-engine'
import { createCastaliaFullClient, resolveCastaliaFullUrl } from './castalia-full'
import { createInProcessBankMemory } from './castalia-inprocess'
import { applyStoredTuning, getTuningSnapshot, saveTuning } from './castalia-tuning'

let repository: ReturnType<typeof createCastaliaMemoryRepository> | undefined
let repositoryPath: string | undefined

/**
 * 记忆维护的落账：一行一次，追加写。
 *
 * 放在 userData 而不是库目录：日志属于这台机器的运行痕迹，不该混进她能读到的记忆库。
 */
function writeMaintenanceLog(report: Awaited<ReturnType<NonNullable<ReturnType<typeof createInProcessBankMemory>['maintain']>>> | Record<string, unknown>) {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const r = report as Record<string, any>
    const summary = [
      `${r.startedAt ?? new Date().toISOString()}`,
      `ok=${r.ok}`,
      `ms=${r.ms}`,
      `reflect=${JSON.stringify(r.reflect ?? null)}`,
      `consolidate=${JSON.stringify(r.consolidate ?? null)}`,
      `digest=${JSON.stringify(r.digest ?? null)}`,
      r.before ? `before=${JSON.stringify(r.before)}` : '',
      r.after ? `after=${JSON.stringify(r.after)}` : '',
      r.error ? `error=${r.error}` : '',
    ].filter(Boolean).join(' ')
    appendFileSync(join(dir, 'memory-maintenance.log'), `${summary}\n`)
  }
  catch (error) {
    console.warn('[castalia] maintenance log write failed:', (error as Error).message)
  }
}

/**
 * 每日一次的维护调度：抽取 → 整合 → digest。
 *
 * 边界（照这条链的真实形状）：只有 app 主进程 ↔ anima 两段，所以调度器长在这里；
 * Full 总线是只读旁路，不参与写入，也不承担调度。
 *
 * 为什么不在每轮对话后跑：一次维护要 3 次 LLM 调用、几十秒，跟在回复后面会拖慢体感；
 * 对话期间只做写回（ingestTurn），整理留给夜间。
 * 关闭方式：CASTALIA_MAINTENANCE=off。
 */
/** setupCastaliaMemoryService 每个窗口注册一次；维护只能有一个调度器，否则会并发整理同一个库 */
let maintenanceScheduled = false

function scheduleMemoryMaintenance(engine: CastaliaEngineMemory) {
  if (maintenanceScheduled)
    return
  if (process.env.CASTALIA_MAINTENANCE === 'off') {
    console.info('[castalia] memory maintenance disabled (CASTALIA_MAINTENANCE=off)')
    return
  }
  if (!engine.maintain) {
    console.info('[castalia] memory maintenance unavailable on this backend')
    return
  }

  const stateFile = () => join(app.getPath('userData'), 'castalia-maintenance.json')
  const lastRunAt = (): number => {
    try {
      const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
      return Number(parsed?.lastRunAt) || 0
    }
    catch { return 0 }
  }
  const markRun = () => {
    try { writeFileSync(stateFile(), JSON.stringify({ lastRunAt: Date.now() }), 'utf8') }
    catch { /* 状态写不进去不影响本次维护 */ }
  }

  /** 两次维护之间至少隔这么久：既挡住重复触发，也避免同一晚跑两遍 */
  const MIN_GAP_MS = 20 * 3_600_000
  let running = false
  let timer: ReturnType<typeof setInterval> | undefined

  const run = async (reason: string) => {
    if (running)
      return
    if (Date.now() - lastRunAt() < MIN_GAP_MS)
      return
    running = true
    try {
      console.info(`[castalia] maintenance start (${reason})`)
      const report = await engine.maintain!({ limit: 30 })
      markRun()
      writeMaintenanceLog(report)
      console.info(`[castalia] maintenance done in ${report.ms}ms ok=${report.ok}`)
    }
    catch (error) {
      console.warn('[castalia] maintenance failed:', (error as Error).message)
    }
    finally {
      running = false
    }
  }

  maintenanceScheduled = true
  console.info('[castalia] memory maintenance scheduled (daily 04:00-06:00, catch-up 3 min after start)')

  // 启动后先让界面稳定 3 分钟，再决定要不要补跑（错过夜间时段的情况）。
  const startupDelay = setTimeout(() => { void run('startup-catchup') }, 3 * 60_000)
  // 之后每 30 分钟看一眼：是否已跨过本地 04:00 且当天没跑过（由 MIN_GAP 兜底）。
  timer = setInterval(() => {
    const hour = new Date().getHours()
    if (hour >= 4 && hour < 6)
      void run('nightly')
  }, 30 * 60_000)

  app.once('before-quit', () => {
    clearTimeout(startupDelay)
    if (timer)
      clearInterval(timer)
  })
}

function scheduleSelfCycle(engine: CastaliaEngineMemory) {
  if (process.env.CASTALIA_SELF_CYCLE === 'off' || !engine.selfCycle) {
    console.info('[castalia] self-cycle disabled or unavailable')
    return
  }
  const intervalMinutes = Number.parseFloat(process.env.SELF_CYCLE_INTERVAL_MINUTES || '360')
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    console.info('[castalia] self-cycle disabled (SELF_CYCLE_INTERVAL_MINUTES <= 0)')
    return
  }
  let running = false
  const run = async (reason: string) => {
    if (running) return
    running = true
    try {
      const report = await engine.selfCycle!({ limit: 6, hoursBack: 48, minIntervalHours: Math.max(0, intervalMinutes / 60) })
      console.info(`[castalia] self-cycle ${reason}: ok=${report.ok} skipped=${report.skipped} reason=${report.reason ?? '-'} evidence=${report.evidenceIds.length}`)
    }
    catch (error) {
      console.warn('[castalia] self-cycle failed:', (error as Error).message)
    }
    finally { running = false }
  }
  const startupDelay = setTimeout(() => { void run('startup') }, 3 * 60_000)
  const timer = setInterval(() => { void run('interval') }, intervalMinutes * 60_000)
  app.once('before-quit', () => { clearTimeout(startupDelay); clearInterval(timer) })
  console.info(`[castalia] self-cycle scheduled every ${intervalMinutes} minutes`)
}
function getRepository(databasePath: string) {
  if (repository && repositoryPath !== databasePath)
    throw new Error('Castalia memory is already open at a different database path')
  if (!repository) {
    mkdirSync(dirname(databasePath), { recursive: true })
    const database = new DatabaseSync(databasePath)
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    repository = createCastaliaMemoryRepository(database)
    repositoryPath = databasePath
  }
  return repository
}

/**
 * Registers the durable memory backend on one renderer's Eventa context.
 *
 * Prefers the Castalia memory bank named by `castalia-engine.json` or the
 * `CASTALIA_*` environment variables, so the same bank serves every other client.
 * Falls back to the local `userData/castalia/memory.sqlite` when no engine is
 * configured. There is no built-in default path.
 */
export function setupCastaliaMemoryService(params: {
  context: ReturnType<typeof createContext>['context']
  databasePath: string
}) {
  const userDataDir = app.getPath('userData')

  // Full 总线（跨库总览/检索）：与"本库"后端无关，总线不在线时返回 ok:false 而不是抛错。
  const full = createCastaliaFullClient({ url: resolveCastaliaFullUrl(userDataDir) })
  defineInvokeHandler(params.context, castaliaFullMembers, () => full.members())
  defineInvokeHandler(params.context, castaliaFullSearch, input => full.search(input))
  defineInvokeHandler(params.context, castaliaOpenConsole, input => openCastaliaConsole(input))

  const engineOptions = resolveCastaliaEngineOptions(userDataDir)

  // 每一轮落库都走引擎的完整 autoProcess（VAD 队列 + 会话缓冲），而不是最小路径。
  // 只有这条路径会给情绪链喂原料：最小路径只写 conversation_log，psyche_events 永远是 0。
  // 显式设 MEMORY_AUTO_PROCESS=0 可以退回最小路径做对照。
  process.env.MEMORY_AUTO_PROCESS ??= '1'
  // 情绪分析的 VAD 模型：优先本机 Lemonade 的 OpenAI 兼容端点（免费、不走网）。没有这一条时，
  // 引擎只会去敲 127.0.0.1:11434 的 Ollama（本机没跑），每批 404 后落到词表——实测只覆盖 30% 的对话。
  // 无论走引擎还是本地 sqlite 都先应用一次 —— 面板要能看到「实际生效值」。
  applyStoredTuning(userDataDir)
  defineInvokeHandler(params.context, castaliaTuningGet, () => getTuningSnapshot(userDataDir))
  defineInvokeHandler(params.context, castaliaTuningSave, input => saveTuning(userDataDir, input?.values ?? {}))

  if (engineOptions) {
    // 默认在主进程内直连记忆库（不再 spawn 子进程、不走 MCP/HTTP）；
    // CASTALIA_MEMORY_TRANSPORT=stdio 可切回旧的子进程路径做对照/兜底。
    const transport = process.env.CASTALIA_MEMORY_TRANSPORT === 'stdio' ? 'stdio' : 'in-process'
    const engine = transport === 'in-process'
      ? createInProcessBankMemory(engineOptions)
      : createCastaliaEngineMemory(engineOptions)
    console.info(`[castalia] memory backend: ${transport} bank=${engineOptions.bankDir} project=${engineOptions.project}`)
    defineInvokeHandler(params.context, castaliaMemoryList, () => engine.list())
    defineInvokeHandler(params.context, castaliaMemorySave, entry => engine.save(entry))
    defineInvokeHandler(params.context, castaliaMemoryForget, entry => engine.forget(entry))
    defineInvokeHandler(params.context, castaliaMemoryRecall, query => engine.recall(query))
    // 自回归结束后把这一轮写回库：这是"她记得刚才说过什么"的唯一入口。
    // 没有 ingest 的实现（stdio 旧路径）时返回 ok:false，不抛错、不影响回复。
    defineInvokeHandler(params.context, castaliaMemoryIngest, turn => engine.ingest
      ? engine.ingest(turn)
      : Promise.resolve({ ok: false, error: 'transport has no ingest' }))
    // 记忆维护（抽取 + 整合 + digest）就在这个进程里跑：这条链只有 app ↔ anima 两段，
    // 不需要第二个运行时来调度。手动触发用同一入口，定时器见 scheduleMemoryMaintenance。
    defineInvokeHandler(params.context, castaliaMemoryMaintain, async (input) => {
      if (!engine.maintain)
        return { ok: false, startedAt: new Date().toISOString(), ms: 0, reflectConfigured: false, error: 'backend has no maintain' }
      const report = await engine.maintain({ limit: input?.limit })
      writeMaintenanceLog(report)
      return report
    })
    defineInvokeHandler(params.context, castaliaMemoryPsyche, async (input) => {
      if (!engine.psycheState)
        return null
      return engine.psycheState(input ?? {})
    })
    defineInvokeHandler(params.context, castaliaMemorySelfCycle, async (input) => {
      if (!engine.selfCycle)
        return { ok: false, skipped: true, reason: 'backend has no self-cycle', evidenceIds: [], project: '' }
      return engine.selfCycle(input)
    })
    scheduleMemoryMaintenance(engine)
    if (transport === 'in-process')
      scheduleSelfCycle(engine)
    app.once('before-quit', () => {
      void engine.close()
    })
    return
  }

  console.info(`[castalia] memory backend: local sqlite ${params.databasePath} (set castalia-engine.json to use the Castalia bank)`)
  const memory = getRepository(params.databasePath)
  defineInvokeHandler(params.context, castaliaMemoryList, () => memory.list())
  defineInvokeHandler(params.context, castaliaMemorySave, entry => memory.save(entry))
  defineInvokeHandler(params.context, castaliaMemoryForget, entry => memory.forget(entry))
  // The local repository holds entries only, so a recall has no ranked text to render.
  defineInvokeHandler(params.context, castaliaMemoryRecall, () => ({ text: '', count: 0, topSim: 0, chars: 0 }))
  // 本地 sqlite 仓储只有条目、没有对话日志表，所以落库明确返回不可用。
  defineInvokeHandler(params.context, castaliaMemoryIngest, () => ({ ok: false, error: 'no castalia bank configured' }))
  defineInvokeHandler(params.context, castaliaMemoryMaintain, () => ({ ok: false, startedAt: new Date().toISOString(), ms: 0, reflectConfigured: false, error: 'no castalia bank configured' }))
  defineInvokeHandler(params.context, castaliaMemorySelfCycle, () => ({ ok: false, skipped: true, reason: 'no castalia bank configured', evidenceIds: [], project: '' }))
  defineInvokeHandler(params.context, castaliaMemoryPsyche, () => null)
}
