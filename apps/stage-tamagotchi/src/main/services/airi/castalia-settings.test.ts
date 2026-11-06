import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readCastaliaSettings, writeCastaliaSettings } from './castalia-settings'

const dirs: string[] = []

function bank(config?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'castalia-settings-'))
  dirs.push(dir)
  if (config)
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2))
  return { bankDir: dir, project: 'airi', character: 'default' }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('readCastaliaSettings', () => {
  it('reports a bank with no config as empty instead of failing', () => {
    const target = bank()

    const snapshot = readCastaliaSettings(target)

    expect(snapshot.configExists).toBe(false)
    expect(snapshot.keysExists).toBe(false)
    expect(snapshot.embedding.mode).toBe('ollama')
    expect(snapshot.embedding.hasApiKey).toBe(false)
  })

  it('never returns the api key itself', () => {
    const target = bank({ embedding: { mode: 'api', api_url: 'https://api.example/v1', api_model: 'bge-m3', api_key: 'sk-should-not-leak' } })

    const snapshot = readCastaliaSettings(target)

    expect(snapshot.embedding.hasApiKey).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('sk-should-not-leak')
  })
})

describe('writeCastaliaSettings', () => {
  it('keeps keys it does not own', () => {
    const target = bank({ db_dir: 'D:/somewhere', personas: { airi: { charId: 'x' } }, embedding: { mode: 'ollama' } })

    const result = writeCastaliaSettings(target, { embedding: { mode: 'api', apiUrl: 'https://api.siliconflow.cn/v1', apiModel: 'BAAI/bge-m3' } })

    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(join(target.bankDir, 'config.json'), 'utf-8'))
    expect(written.db_dir).toBe('D:/somewhere')
    expect(written.personas).toEqual({ airi: { charId: 'x' } })
    expect(written.embedding).toMatchObject({ mode: 'api', api_url: 'https://api.siliconflow.cn/v1', api_model: 'BAAI/bge-m3' })
  })

  it('stores the api key outside config.json', () => {
    const target = bank({ embedding: { mode: 'api' } })

    const result = writeCastaliaSettings(target, { embedding: { apiKey: 'sk-test-key' } })

    expect(result.keysUpdated).toBe(true)
    expect(readFileSync(join(target.bankDir, 'config.json'), 'utf-8')).not.toContain('sk-test-key')
    expect(existsSync(join(target.bankDir, 'keys.enc'))).toBe(true)
    expect(existsSync(join(target.bankDir, 'keys.key'))).toBe(true)
    expect(readCastaliaSettings(target).embedding.hasApiKey).toBe(true)
  })

  it('removes a plaintext key from config.json when a new one is saved', () => {
    const target = bank({ embedding: { mode: 'api', api_key: 'sk-old' } })

    writeCastaliaSettings(target, { embedding: { apiKey: 'sk-new' } })

    const written = JSON.parse(readFileSync(join(target.bankDir, 'config.json'), 'utf-8'))
    expect(written.embedding.api_key).toBeUndefined()
    expect(readCastaliaSettings(target).embedding.hasApiKey).toBe(true)
  })

  it('clears a key when asked', () => {
    const target = bank({})
    writeCastaliaSettings(target, { reflect: { apiKey: 'sk-reflect' } })

    const result = writeCastaliaSettings(target, { reflect: { clearApiKey: true } })

    expect(result.ok).toBe(true)
    expect(readCastaliaSettings(target).reflect.hasApiKey).toBe(false)
  })

  it('does not create sections the patch never touched', () => {
    const target = bank({})

    writeCastaliaSettings(target, { embedding: { mode: 'ollama' } })

    const written = JSON.parse(readFileSync(join(target.bankDir, 'config.json'), 'utf-8'))
    expect(written.embedding).toEqual({ mode: 'ollama' })
    expect('reflect' in written).toBe(false)
    expect('triage' in written).toBe(false)
  })

  it('keeps a backup of the config it replaces', () => {
    const target = bank({ embedding: { mode: 'ollama' } })

    writeCastaliaSettings(target, { embedding: { mode: 'api' } })

    expect(readdirSync(target.bankDir).some(name => name.startsWith('config.json.bak-'))).toBe(true)
  })

  it('does nothing and says so when nothing changed', () => {
    const target = bank({ embedding: { mode: 'api', api_url: 'https://a' } })

    const result = writeCastaliaSettings(target, { embedding: { apiUrl: 'https://a' } })

    expect(result.changed).toEqual([])
    expect(result.restartRequired).toBe(false)
  })

  it('creates the bank directory for a fresh install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'castalia-settings-'))
    dirs.push(dir)
    const target = { bankDir: join(dir, 'memory-banks'), project: 'airi', character: 'default' }
    mkdirSync(dir, { recursive: true })

    const result = writeCastaliaSettings(target, { embedding: { mode: 'none' } })

    expect(result.ok).toBe(true)
    expect(existsSync(join(target.bankDir, 'config.json'))).toBe(true)
  })
})
