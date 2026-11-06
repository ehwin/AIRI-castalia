import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeCastaliaEngineConfig, resolveCastaliaEngineOptions } from './castalia-engine'

const dirs: string[] = []

function scratch(config: Record<string, unknown>, options: { bank?: boolean, entry?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'castalia-config-'))
  dirs.push(dir)
  const bankDir = join(dir, 'banks')
  const engineEntry = join(dir, 'dist', 'index.js')
  if (options.bank !== false)
    mkdirSync(bankDir, { recursive: true })
  if (options.entry !== false) {
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(engineEntry, '// entry')
  }
  writeFileSync(join(dir, 'castalia-engine.json'), JSON.stringify({ enabled: true, engineEntry, bankDir, project: 'airi', character: 'airi', ...config }, null, 2))
  return { dir, bankDir, engineEntry }
}

afterEach(() => {
  delete process.env.CASTALIA_MEMORY_TRANSPORT
  delete process.env.CASTALIA_BANK_DIR
  delete process.env.CASTALIA_ENGINE_ENTRY
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * F05: the resolver collapsed "no config", "bad path" and "disabled" into `undefined`, and the
 * module still showed as configured. Each failure now names itself.
 */
describe('describeCastaliaEngineConfig', () => {
  it('accepts a bank with a reachable dir, in the default in-process transport', () => {
    const { dir, bankDir } = scratch({})

    expect(describeCastaliaEngineConfig(dir)).toMatchObject({ ok: true, bankDir, project: 'airi', character: 'airi' })
  })

  // In-process mode never starts the entry file, so requiring it hid a bank that works.
  it('does not demand the engine entry file in in-process mode', () => {
    const { dir } = scratch({}, { entry: false })

    expect(describeCastaliaEngineConfig(dir)).toMatchObject({ ok: true })
  })

  it('demands the engine entry file in stdio mode', () => {
    process.env.CASTALIA_MEMORY_TRANSPORT = 'stdio'
    const { dir, engineEntry } = scratch({}, { entry: false })

    expect(describeCastaliaEngineConfig(dir)).toMatchObject({ ok: false })
    expect(describeCastaliaEngineConfig(dir).reason).toContain(engineEntry)
  })

  it('names a missing bank directory instead of failing silently', () => {
    const { dir, bankDir } = scratch({}, { bank: false })

    const described = describeCastaliaEngineConfig(dir)
    expect(described.ok).toBe(false)
    expect(described.reason).toContain(bankDir)
  })

  // 全新安装：没有 castalia-engine.json 也不该退回「只有条目仓储」。引擎代码在包里，
  // 缺的只是库目录 —— 这里给出 userData 下的默认库，并允许无 config 打开（固定 FTS）。
  it('hands a fresh profile its own bank under userData', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castalia-config-'))
    dirs.push(dir)

    const described = describeCastaliaEngineConfig(dir)

    expect(described).toMatchObject({ ok: true, source: 'default', project: 'airi', character: 'default' })
    expect(described.bankDir).toBe(join(dir, 'memory-banks'))
    expect(existsSync(described.bankDir!)).toBe(true)
    expect(resolveCastaliaEngineOptions(dir)?.allowNoConfig).toBe(true)
  })

  it('does not fall back to the default when a config file exists but its bank is missing', () => {
    const { dir } = scratch({}, { bank: false })

    expect(describeCastaliaEngineConfig(dir).ok).toBe(false)
    expect(resolveCastaliaEngineOptions(dir)).toBeUndefined()
  })

  it('reports an explicitly disabled config', () => {
    const { dir } = scratch({ enabled: false })

    expect(describeCastaliaEngineConfig(dir)).toMatchObject({ ok: false })
    expect(describeCastaliaEngineConfig(dir).reason).toContain('enabled=false')
  })
})
