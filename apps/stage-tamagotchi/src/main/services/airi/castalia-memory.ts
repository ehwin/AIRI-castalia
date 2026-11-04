import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { CastaliaMaintainReport } from '../../../shared/eventa/castalia-memory'
import type { CastaliaEngineMemory } from './castalia-engine'

import process from 'node:process'

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineInvokeHandler } from '@moeru/eventa'
import { createCastaliaMemoryRepository } from '@proj-airi/castalia-plugin/memory'
import { app } from 'electron'

import { castaliaFullMembers, castaliaFullSearch, castaliaMemoryApplyEmotion, castaliaMemoryFacts, castaliaMemoryForget, castaliaMemoryIngest, castaliaMemoryList, castaliaMemoryMaintain, castaliaMemoryPsyche, castaliaMemoryRecall, castaliaMemorySave, castaliaMemorySearch, castaliaMemorySelfCycle, castaliaMemorySetEnabled, castaliaMemorySetEnergy, castaliaMemoryStatus, castaliaOpenConsole, castaliaTuningGet, castaliaTuningSave } from '../../../shared/eventa/castalia-memory'
import { openCastaliaConsole } from './castalia-console'
import { createCastaliaEngineMemory, describeCastaliaEngineConfig, resolveCastaliaEngineOptions } from './castalia-engine'
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

/**
 * 维护的落账与串行化。
 *
 * 两个入口共用这一份：04:00–06:00 的夜班，和 mind 睡下时的那一次。没有共享落账时，
 * 她 23:00 睡下跑过一次，04:00 的定时器还会再跑一遍 —— 同一晚整理两次、烧两次 token。
 */
const maintenanceStateFile = () => join(app.getPath('userData'), 'castalia-maintenance.json')

/** Twice a night is already too often; a failed run retries much sooner. */
const MIN_GAP_MS = 20 * 3_600_000
const RETRY_GAP_MS = 30 * 60_000

/**
 * The ledger answers two different questions: when did we last try, and when
 * did it last work. Recording only the attempt (and doing it even on failure)
 * used to suppress the nightly retry for a full day, and the sleep path had no
 * cooldown at all, so 04:00 → morning sleep ran the whole cycle again.
 */
interface MaintenanceLedger {
  lastAttemptAt?: number
  lastSuccessAt?: number
  lastOk?: boolean
  lastReason?: string
  /** Full report of the last finished run, reused when a request is skipped. */
  lastReport?: CastaliaMaintainReport
  /** Old shape, kept so an existing file is not read as "never ran". */
  lastRunAt?: number
}

function readMaintenanceLedger(): MaintenanceLedger {
  try {
    const parsed = JSON.parse(readFileSync(maintenanceStateFile(), 'utf8'))
    const legacy = Number(parsed?.lastRunAt) || 0
    return {
      ...parsed,
      lastAttemptAt: Number(parsed?.lastAttemptAt) || legacy || undefined,
      lastSuccessAt: Number(parsed?.lastSuccessAt) || legacy || undefined,
    }
  }
  catch {
    return {}
  }
}

function writeMaintenanceLedger(ledger: MaintenanceLedger): void {
  try {
    writeFileSync(maintenanceStateFile(), JSON.stringify(ledger), 'utf8')
  }
  catch { /* 状态写不进去不影响本次维护 */ }
}

/**
 * 面板开关的镜像。默认全开，渲染层启动后立刻推一次真实值。
 *
 * 定时器是主进程排的，面板关掉模块不会自动通知它们；每个 tick 先问一次这里（审计 A06）。
 */
let moduleEnabled = { memory: true, castalia: true }

let maintenanceInFlight: Promise<CastaliaMaintainReport> | undefined
/**
 * Exported for the sleep path; both callers go through the same queue.
 *
 * @internal
 */
export async function runMaintenance(
  engine: CastaliaEngineMemory,
  reason: string,
  limit = 30,
  options: { force?: boolean } = {},
): Promise<CastaliaMaintainReport> {
  if (maintenanceInFlight)
    return maintenanceInFlight

  const now = Date.now()
  const ledger = readMaintenanceLedger()
  const gap = ledger.lastOk === false ? RETRY_GAP_MS : MIN_GAP_MS
  if (!options.force && ledger.lastAttemptAt && now - ledger.lastAttemptAt < gap) {
    const minutes = Math.round((gap / 60_000))
    console.info(`[castalia] maintenance skipped (${reason}): last ${ledger.lastOk === false ? 'failed' : 'succeeded'} ${Math.round((now - ledger.lastAttemptAt) / 60_000)} min ago, gap ${minutes} min`)
    return {
      ...(ledger.lastReport ?? {}),
      ok: Boolean(ledger.lastOk),
      skipped: true,
      skippedReason: `cooldown:${minutes}min`,
      startedAt: ledger.lastReport?.startedAt ?? new Date().toISOString(),
      ms: 0,
      reflectConfigured: Boolean(ledger.lastReport?.reflectConfigured),
    } as CastaliaMaintainReport
  }

  ledger.lastAttemptAt = now
  ledger.lastReason = reason
  writeMaintenanceLedger(ledger)
  const task = (async () => {
    console.info(`[castalia] maintenance start (${reason})`)
    let report: CastaliaMaintainReport
    try {
      report = await engine.maintain!({ limit }) as CastaliaMaintainReport
    }
    catch (error) {
      writeMaintenanceLedger({ ...ledger, lastAttemptAt: Date.now(), lastOk: false, lastReason: reason })
      throw error
    }
    const ok = Boolean(report.ok)
    writeMaintenanceLedger({
      lastAttemptAt: Date.now(),
      lastSuccessAt: ok ? Date.now() : ledger.lastSuccessAt,
      lastOk: ok,
      lastReason: reason,
      lastReport: report,
    })
    writeMaintenanceLog(report)
    console.info(`[castalia] maintenance done in ${report.ms}ms ok=${ok} (${reason})`)
    return report
  })()
  maintenanceInFlight = task
  try {
    return await task
  }
  finally {
    maintenanceInFlight = undefined
  }
}

/**
 * 每两分钟看一眼 VAD 队列有没有超龄批次（审计 F07）。
 *
 * 队列原本只在「下一条消息」或维护时被检查，所以一段安静下来的对话永远等不到情感更新。
 * 没有超龄批次时这里什么都不做。
 */
function scheduleVadAgeSweep(engine: CastaliaEngineMemory) {
  const minutes = Number(process.env.VAD_SWEEP_MINUTES ?? 2)
  if (!Number.isFinite(minutes) || minutes <= 0)
    return
  if (typeof engine.flushStaleVadQueue !== 'function') {
    console.info('[castalia] vad sweep unavailable on this backend (no flushStaleVadQueue)')
    return
  }
  const timer = setInterval(() => {
    if (!moduleEnabled.memory)
      return
    void engine.flushStaleVadQueue?.()
      .then((result) => {
        if (result && result.updated > 0)
          console.info(`[castalia] vad sweep flushed ${result.updated} (pending ${result.pending})`)
      })
      .catch(() => {})
  }, minutes * 60_000)
  timer.unref?.()
}

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

  const run = async (reason: string) => {
    if (!moduleEnabled.memory)
      return
    try {
      await runMaintenance(engine, reason, 30)
    }
    catch (error) {
      console.warn('[castalia] maintenance failed:', (error as Error).message)
    }
  }

  maintenanceScheduled = true
  console.info('[castalia] memory maintenance scheduled (daily 04:00-06:00, catch-up 3 min after start)')

  // 启动后先让界面稳定 3 分钟，再决定要不要补跑（错过夜间时段的情况）。
  const startupDelay = setTimeout(() => {
    void run('startup-catchup')
  }, 3 * 60_000)
  // 之后每 30 分钟看一眼：是否已跨过本地 04:00 且当天没跑过（由 MIN_GAP 兜底）。
  const timer = setInterval(() => {
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
    if (!moduleEnabled.castalia)
      return
    if (running) {
      return
    }
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
  const startupDelay = setTimeout(() => {
    void run('startup')
  }, 3 * 60_000)
  const timer = setInterval(() => {
    void run('interval')
  }, intervalMinutes * 60_000)
  app.once('before-quit', () => {
    clearTimeout(startupDelay)
    clearInterval(timer)
  })
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
    const transport: 'stdio' | 'in-process' = process.env.CASTALIA_MEMORY_TRANSPORT === 'stdio' ? 'stdio' : 'in-process'
    const engine = transport === 'in-process'
      ? createInProcessBankMemory(engineOptions)
      : createCastaliaEngineMemory(engineOptions)
    console.info(`[castalia] memory backend: ${transport} bank=${engineOptions.bankDir} project=${engineOptions.project}`)
    // The switch only says "on"; this is the answer to "can it actually recall / search / ingest".
    defineInvokeHandler(params.context, castaliaMemorySetEnabled, (input) => {
      moduleEnabled = { memory: Boolean(input?.memory), castalia: Boolean(input?.castalia) }
      console.info(`[castalia] module switches: memory=${moduleEnabled.memory} castalia=${moduleEnabled.castalia}`)
      return { ok: true }
    })
  // 模型判断出的情绪落到引擎 psyche 的唯一入口。没有它的后端如实回答 unsupported，
  // 面板据此说明「只写提示词」，而不是让读者以为引擎也在动。
  defineInvokeHandler(params.context, castaliaMemoryApplyEmotion, async input => engine.applyEmotion
    ? await engine.applyEmotion({ ...input })
    : { applied: false, reason: 'unsupported' as const, version: 0 })
  defineInvokeHandler(params.context, castaliaMemoryStatus, () => ({
      transport,
      project: engineOptions.project,
      character: engineOptions.character,
      engineEntry: engineOptions.engineEntry,
      capabilities: {
        // stdio 后端没有队列工具，这里如实说"扫不了"，而不是让扫描器每年安静空转。
        vadSweep: typeof engine.flushStaleVadQueue === 'function',
        recall: typeof engine.recall === 'function',
        search: typeof engine.search === 'function',
        facts: typeof engine.facts === 'function',
        ingest: typeof engine.ingest === 'function',
        maintain: typeof engine.maintain === 'function',
        selfCycle: typeof engine.selfCycle === 'function',
        psyche: typeof engine.psycheState === 'function',
      },
      ...(transport === 'stdio' && typeof engine.search !== 'function'
        ? { error: 'stdio 后端没有暴露 search/facts，检索会一直是空' }
        : {}),
      // 自动情感还有一道独立实验门槛（审计 F06）：模块开着也可能一步都不推进 psyche。
      entries: (() => {
        const stats = engine.listStats?.()
        return stats ? { ...stats } : undefined
      })(),
      emotion: (() => {
        // The engine gates on `process.env.PSYCHE_FROM_VAD === 'on'` exactly. Reporting `1`/`true`/
        // `ON` as enabled would show a switch the engine ignores (audit A12).
        const raw = process.env.PSYCHE_FROM_VAD
        const autoFromVad = raw === 'on'
        const offByAlias = !autoFromVad && raw !== undefined && String(raw).toLowerCase() === 'on'
        const estimator: 'model' | 'lexicon' = process.env.OLLAMA_URL || process.env.VAD_MODEL ? 'model' : 'lexicon'
        // 有没有显式写入通道，决定 recordEmotion 是真写 psyche 还是只写提示词。
        const explicit = typeof engine.applyEmotion === 'function'
        const note = offByAlias
          ? `PSYCHE_FROM_VAD 的值是 "${raw}"，引擎只认小写 on，所以自动情感仍然关闭${explicit ? '（模型主动记录的情绪仍会写入 psyche）' : ''}`
          : !autoFromVad
            ? explicit
              ? 'PSYCHE_FROM_VAD 未开启：对话不会自动推进 psyche，但 recordEmotion 会把模型判断的情绪写进引擎'
              : 'PSYCHE_FROM_VAD 未开启：对话不会推进 psyche，recordEmotion 只写提示词'
          : estimator === 'lexicon'
            ? '自动情感已开启，但只有本地词表可用：它会对模糊句子主动放弃判断，psyche 多数时候不动'
            : '自动情感已开启，分析来自模型端点'
        return { autoFromVad, explicit, estimator, note }
      })(),
      checkedAt: Date.now(),
    }))
    defineInvokeHandler(params.context, castaliaMemoryList, () => engine.list())
    defineInvokeHandler(params.context, castaliaMemorySave, entry => engine.save(entry))
    defineInvokeHandler(params.context, castaliaMemoryForget, entry => engine.forget(entry))
    defineInvokeHandler(params.context, castaliaMemoryRecall, input => engine.recall(String(input?.query ?? ''), input?.persona))
    // 显式检索（模型主动查记忆）：与 recall 不同，不过相似度门槛、不渲染注入块。
    defineInvokeHandler(params.context, castaliaMemorySearch, input => engine.search
      ? engine.search(String(input?.query ?? ''), input?.topK, input?.persona)
      : Promise.resolve([]))
    defineInvokeHandler(params.context, castaliaMemoryFacts, input => engine.facts
      ? engine.facts(String(input?.query ?? ''), input?.topK, input?.persona)
      : Promise.resolve([]))
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
      // Same queue and same ledger as the 04:00 sweep: a sleep-triggered run at
      // 23:00 makes the nightly one a no-op instead of a second consolidation.
      return runMaintenance(engine, 'renderer', input?.limit ?? 30)
    })
    defineInvokeHandler(params.context, castaliaMemoryPsyche, async (input) => {
      if (!engine.psycheState)
        return null
      return engine.psycheState(input ?? {})
    })
    defineInvokeHandler(params.context, castaliaMemorySetEnergy, async (input) => {
      if (engine.setSelfEnergy)
        await engine.setSelfEnergy(Number(input?.value) || 0, input?.persona)
      return { ok: Boolean(engine.setSelfEnergy) }
    })
    defineInvokeHandler(params.context, castaliaMemorySelfCycle, async (input) => {
      if (!engine.selfCycle)
        return { ok: false, skipped: true, reason: 'backend has no self-cycle', evidenceIds: [], project: '' }
      return engine.selfCycle(input)
    })
    scheduleMemoryMaintenance(engine)
    scheduleVadAgeSweep(engine)
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
  defineInvokeHandler(params.context, castaliaMemoryForget, entry => entry.name
    ? memory.forget({ name: entry.name, ...(entry.persona ? { persona: entry.persona } : {}) })
    : false)
  // The local repository holds entries only, so a recall has no ranked text to render.
  defineInvokeHandler(params.context, castaliaMemoryRecall, () => ({ text: '', count: 0, topSim: 0, chars: 0 }))
  // 本地仓储同样没有语义检索：明确返回空列表（模型会如实说"没找到"）。
  defineInvokeHandler(params.context, castaliaMemorySearch, () => [])
  defineInvokeHandler(params.context, castaliaMemoryFacts, () => [])
  // 本地 sqlite 仓储只有条目、没有对话日志表，所以落库明确返回不可用。
  defineInvokeHandler(params.context, castaliaMemoryIngest, () => ({ ok: false, error: 'no castalia bank configured' }))
  defineInvokeHandler(params.context, castaliaMemoryMaintain, () => ({ ok: false, startedAt: new Date().toISOString(), ms: 0, reflectConfigured: false, error: 'no castalia bank configured' }))
  defineInvokeHandler(params.context, castaliaMemorySelfCycle, () => ({ ok: false, skipped: true, reason: 'no castalia bank configured', evidenceIds: [], project: '' }))
  defineInvokeHandler(params.context, castaliaMemoryPsyche, () => null)
  defineInvokeHandler(params.context, castaliaMemorySetEnabled, (input) => {
    moduleEnabled = { memory: Boolean(input?.memory), castalia: Boolean(input?.castalia) }
    return { ok: true }
  })
  // 完整引擎没起来时，面板必须说清楚现在只是「条目读写」，而不是装作语义检索还在。
  const described = describeCastaliaEngineConfig(userDataDir)
  defineInvokeHandler(params.context, castaliaMemoryStatus, () => ({
    transport: 'entry-only' as const,
    capabilities: { vadSweep: false, recall: false, search: false, facts: false, ingest: false, maintain: false, selfCycle: false, psyche: false },
    error: `完整引擎没有启用，只有条目读写：${described.reason ?? '配置不可用'}`,
    checkedAt: Date.now(),
  }))
}
