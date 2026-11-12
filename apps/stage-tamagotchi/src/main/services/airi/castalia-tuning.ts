// NOTICE: `castalia-engine.json` 里 `tuning` 一节的读写与注入（2026-10-31）。
// why: 心智/检索参数（band 中心、半衰期、权重、注入门槛）原本只能靠环境变量，改一次要动
//      启动脚本；而 AIRI 的引擎是**进程内**加载的（openBank → vendor/engine），env 必须在
//      模块求值前就位，所以这件事只能由主进程做。
// 边界: 这里只做「白名单校验 + 落盘 + 注入 process.env」，参数的含义与取值范围在
//      `@proj-airi/castalia-plugin/tuning`（引擎侧清单）。
import process from 'node:process'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { applyTuning, coerceTuning, needsRestart, readTuningFromEnv, specOf, TUNING_SPECS } from '@proj-airi/castalia-plugin/tuning'

export interface CastaliaEngineConfigWithTuning {
  enabled?: boolean
  engineEntry?: string
  bankDir?: string
  project?: string
  character?: string
  nodeBinary?: string
  /** 心智/检索参数：env 名 → 字符串值。只存与默认不同的键。 */
  tuning?: Record<string, string>
  [key: string]: unknown
}

export interface CastaliaTuningSnapshot {
  /** 配置文件绝对路径（UI 里显示出来，方便手改） */
  file: string
  /** 文件里持久化的值 */
  values: Record<string, string>
  /** 当前进程 env 里实际生效的值（可能还含启动脚本给的） */
  effective: Record<string, string>
  /** 保存时被拒绝的键（白名单外 / 越界 / 非数字） */
  rejected: { key: string, reason: string }[]
  /** 这组值里是否有必须重启 app 才生效的键（检索权重是模块级常量） */
  needsRestart: boolean
}

function tuningPath(userDataDir: string): string {
  return join(userDataDir, 'castalia-engine.json')
}

function readConfigFile(userDataDir: string): CastaliaEngineConfigWithTuning {
  const file = tuningPath(userDataDir)
  if (!existsSync(file))
    return {}
  try {
    return JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF+/, '')) as CastaliaEngineConfigWithTuning
  }
  catch {
    // 坏文件不覆盖：读到空配置，但保存时会保留原文件里解析不了的内容吗？——不会，
    // 所以这里明确只承诺「不会因为坏文件崩掉」，用户要修手改那一份。
    return {}
  }
}

function writeConfigFile(userDataDir: string, config: CastaliaEngineConfigWithTuning): void {
  const file = tuningPath(userDataDir)
  // 2 空格 + 结尾换行：这个文件人也会手改，diff 要能看。
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

/**
 * 把文件里的 tuning 注入 process.env。**必须在引擎模块求值前调用**
 * （`setupCastaliaMemoryService` 里、`createInProcessBankMemory` 之前）。
 */
export function applyStoredTuning(userDataDir: string): string[] {
  const config = readConfigFile(userDataDir)
  const { values } = coerceTuning(config.tuning ?? {})
  const applied = applyTuning(process.env, values)
  // 文件里有 `tuning` 这一节 = 面板是权威来源：白名单内、文件里没写的键要从 env 里清掉，
  // 否则「在面板里恢复默认」会被机器级环境变量（setx 设的 PSYCHE_*）偷偷盖回去。
  if ('tuning' in config) {
    for (const spec of TUNING_SPECS) {
      if (!(spec.key in values) && process.env[spec.key] !== undefined) {
        delete process.env[spec.key]
        applied.push(`-${spec.key}`)
      }
    }
  }
  if (applied.length > 0)
    console.info(`[castalia] tuning applied: ${applied.join(', ')}`)
  return applied
}

export function getTuningSnapshot(userDataDir: string): CastaliaTuningSnapshot {
  const config = readConfigFile(userDataDir)
  const { values, rejected } = coerceTuning(config.tuning ?? {})
  return {
    file: tuningPath(userDataDir),
    values,
    effective: readTuningFromEnv(process.env),
    rejected,
    // 「读快照」不代表有待重启的改动；这个标记只描述**这次保存**改了什么。
    needsRestart: false,
  }
}

/**
 * 保存一组值。
 *
 * 语义：`null` / `''` / 等于默认值 → 删除该键（回默认）；越界 / 白名单外 → 拒绝且保留旧值；
 * 其余按白名单合并。保存即注入 process.env —— psyche 那批参数是**每轮读取**，改完立刻生效；
 * 检索权重是模块级常量，`needsRestart` 只在这**一次保存**改到它们时为 true。
 */
export function saveTuning(
  userDataDir: string,
  patch: Record<string, string | number | boolean | null>,
): CastaliaTuningSnapshot {
  const config = readConfigFile(userDataDir)
  const stored = { ...config.tuning }
  const before = { ...stored }

  const { values: accepted, rejected: invalid } = coerceTuning(patch)
  const invalidKeys = new Set(invalid.map(item => item.key))

  for (const [key, raw] of Object.entries(patch)) {
    if (!specOf(key))
      continue // 白名单外：已在 rejected 里
    if (raw === null || raw === '') {
      delete stored[key]
      continue
    }
    if (invalidKeys.has(key))
      continue // 越界/非数字：保留旧值，让用户看见拒绝原因
    if (accepted[key] === undefined)
      delete stored[key] // 与默认值相同 → 不落盘
    else
      stored[key] = accepted[key]
  }

  const changed = Object.keys({ ...before, ...stored }).filter(key => before[key] !== stored[key])
  applyTuning(process.env, accepted)
  for (const key of changed) {
    if (!(key in stored))
      delete process.env[key]
  }

  // 写回前再归一一次：手改过的文件里可能有越界/未知键，顺手清掉（但保留其它字段）。
  const { values: canonical } = coerceTuning(stored)
  // 即使一个键都没有也保留空的 `tuning`：它的**存在**表示「面板是权威来源」，
  // 启动时会据此清掉环境变量里的同名键（见 applyStoredTuning）。
  writeConfigFile(userDataDir, { ...config, tuning: canonical })

  console.info(`[castalia] tuning saved: ${changed.join(', ') || '(no change)'}`)
  return {
    ...getTuningSnapshot(userDataDir),
    rejected: invalid,
    // 只报告「这次保存」是否动到需要重启的键：文件里长期存着 WEIGHT_TIME 不该让面板永远提示重启。
    needsRestart: needsRestart(Object.fromEntries(changed.map(key => [key, stored[key] ?? '']))),
  }
}
