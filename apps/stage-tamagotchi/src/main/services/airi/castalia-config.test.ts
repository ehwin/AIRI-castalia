import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeCastaliaEngineConfig } from './castalia-engine'

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

  it('reports an explicitly disabled config', () => {
    const { dir } = scratch({ enabled: false })

    expect(describeCastaliaEngineConfig(dir)).toMatchObject({ ok: false })
    expect(describeCastaliaEngineConfig(dir).reason).toContain('enabled=false')
  })
})
