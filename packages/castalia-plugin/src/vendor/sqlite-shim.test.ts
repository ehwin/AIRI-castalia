import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 向量扩展的查找顺序。
 *
 * 之前只有本机运行库里的两条 `D:/castalia/...`，换台机器就找不到 `vec0.dll`，检索静默退化成
 * FTS。打包后那份在 `resources/castalia/`，必须排在开发机路径前面 —— 否则开发机上的旧 dll
 * 会盖过随包分发的那份。
 */
describe('resolveVecExtension', () => {
  afterEach(() => {
    delete (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    delete process.env.CASTALIA_VEC_EXT
    vi.resetModules()
  })

  it('uses the dll that travels with the app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vec-ext-'))
    mkdirSync(join(dir, 'castalia'), { recursive: true })
    const bundled = join(dir, 'castalia', 'vec0.dll')
    writeFileSync(bundled, '')
    ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = dir
    vi.resetModules()

    const { resolveVecExtension } = await import('./sqlite-shim')

    expect(resolveVecExtension()).toBe(bundled)
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets an explicit override win', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vec-ext-'))
    mkdirSync(join(dir, 'castalia'), { recursive: true })
    writeFileSync(join(dir, 'castalia', 'vec0.dll'), '')
    const override = join(dir, 'override.dll')
    writeFileSync(override, '')
    process.env.CASTALIA_VEC_EXT = override
    ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = dir
    vi.resetModules()

    const { resolveVecExtension } = await import('./sqlite-shim')

    expect(resolveVecExtension()).toBe(override)
    rmSync(dir, { recursive: true, force: true })
  })
})
