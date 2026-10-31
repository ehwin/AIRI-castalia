import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyStoredTuning, getTuningSnapshot, saveTuning } from './castalia-tuning'

const TOUCHED = ['PSYCHE_BAND_CENTER_OFFSET', 'PSYCHE_BAND_ENTER', 'PSYCHE_BAND_HOLD', 'WEIGHT_TIME']

let dir: string
const file = () => join(dir, 'castalia-engine.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'castalia-tuning-'))
  writeFileSync(file(), JSON.stringify({
    enabled: true,
    engineEntry: 'D:/x/dist/index.js',
    bankDir: 'D:/banks/airi',
    project: 'airi',
  }, null, 2))
})

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key]
  rmSync(dir, { recursive: true, force: true })
})

describe('saveTuning', () => {
  it('写入白名单内的值，同时保留 engineEntry 等其它字段', () => {
    const snapshot = saveTuning(dir, { PSYCHE_BAND_CENTER_OFFSET: '-0.2', PSYCHE_BAND_ENTER: '0.18' })
    expect(snapshot.values).toEqual({ PSYCHE_BAND_CENTER_OFFSET: '-0.2', PSYCHE_BAND_ENTER: '0.18' })
    expect(snapshot.rejected).toEqual([])

    const onDisk = JSON.parse(readFileSync(file(), 'utf-8'))
    expect(onDisk.engineEntry).toBe('D:/x/dist/index.js')
    expect(onDisk.project).toBe('airi')
    expect(onDisk.tuning).toEqual({ PSYCHE_BAND_CENTER_OFFSET: '-0.2', PSYCHE_BAND_ENTER: '0.18' })
  })

  it('保存即注入 process.env（psyche 那批是每轮读取的）', () => {
    saveTuning(dir, { PSYCHE_BAND_CENTER_OFFSET: '-0.2' })
    expect(process.env.PSYCHE_BAND_CENTER_OFFSET).toBe('-0.2')
  })

  it('null 显式清掉一个键，并把它从 env 里也删掉', () => {
    saveTuning(dir, { PSYCHE_BAND_CENTER_OFFSET: '-0.2' })
    const snapshot = saveTuning(dir, { PSYCHE_BAND_CENTER_OFFSET: null })
    expect(snapshot.values).toEqual({})
    expect(process.env.PSYCHE_BAND_CENTER_OFFSET).toBeUndefined()
    // 空的 `tuning` 仍然保留：它的存在 = 面板是权威来源（见 applyStoredTuning）
    expect(JSON.parse(readFileSync(file(), 'utf-8')).tuning).toEqual({})
  })

  it('白名单外的键被拒绝，且不会落盘', () => {
    const snapshot = saveTuning(dir, { PATH: '/evil', PSYCHE_BAND_ENTER: '0.18' })
    expect(snapshot.rejected).toEqual([{ key: 'PATH', reason: 'unknown-key' }])
    expect(snapshot.values).toEqual({ PSYCHE_BAND_ENTER: '0.18' })
    expect(readFileSync(file(), 'utf-8')).not.toContain('PATH')
  })

  it('越界值被拒绝，旧值不受影响', () => {
    saveTuning(dir, { PSYCHE_BAND_ENTER: '0.18' })
    const snapshot = saveTuning(dir, { PSYCHE_BAND_ENTER: '9' })
    expect(snapshot.rejected[0].key).toBe('PSYCHE_BAND_ENTER')
    expect(snapshot.values).toEqual({ PSYCHE_BAND_ENTER: '0.18' })
  })

  it('写回默认值等于删除（文件保持最小）', () => {
    saveTuning(dir, { PSYCHE_BAND_CENTER_OFFSET: '-0.2' })
    const snapshot = saveTuning(dir, { PSYCHE_BAND_CENTER_OFFSET: '0' })
    expect(snapshot.values).toEqual({})
  })

  it('检索权重标了「需重启」', () => {
    expect(saveTuning(dir, { WEIGHT_TIME: '0.05' }).needsRestart).toBe(true)
    expect(saveTuning(dir, { PSYCHE_BAND_ENTER: '0.18' }).needsRestart).toBe(false)
  })

  it('文件不存在时是空快照，保存会新建一份', () => {
    rmSync(file())
    expect(getTuningSnapshot(dir).values).toEqual({})
    saveTuning(dir, { PSYCHE_BAND_ENTER: '0.18' })
    expect(existsSync(file())).toBe(true)
  })
})

describe('applyStoredTuning', () => {
  it('从文件注入 env，并返回写了哪些键', () => {
    writeFileSync(file(), JSON.stringify({
      enabled: true,
      tuning: { PSYCHE_BAND_CENTER_OFFSET: '-0.35', PSYCHE_BAND_ENTER: '0.12', PSYCHE_BAND_HOLD: '0.05' },
    }))
    const applied = applyStoredTuning(dir)
    expect(applied.sort()).toEqual(['PSYCHE_BAND_CENTER_OFFSET', 'PSYCHE_BAND_ENTER', 'PSYCHE_BAND_HOLD'])
    expect(process.env.PSYCHE_BAND_CENTER_OFFSET).toBe('-0.35')
  })

  it('文件里的越界/未知键不会被注入', () => {
    writeFileSync(file(), JSON.stringify({ tuning: { PSYCHE_BAND_ENTER: '99', PATH: '/evil' } }))
    expect(applyStoredTuning(dir)).toEqual([])
    expect(process.env.PATH).not.toBe('/evil')
  })

  it('文件里有 tuning 节时，它说了算：env 里多余的键会被清掉', () => {
    // 模拟「机器级 setx 设过 PSYCHE_BAND_CENTER_OFFSET，但面板里恢复成了默认」
    process.env.PSYCHE_BAND_CENTER_OFFSET = '-0.35'
    writeFileSync(file(), JSON.stringify({ tuning: {} }))
    const applied = applyStoredTuning(dir)
    expect(applied).toEqual(['-PSYCHE_BAND_CENTER_OFFSET'])
    expect(process.env.PSYCHE_BAND_CENTER_OFFSET).toBeUndefined()
  })

  it('文件里没有 tuning 节时不动 env（手写环境变量的部署照旧可用）', () => {
    process.env.PSYCHE_BAND_CENTER_OFFSET = '-0.35'
    writeFileSync(file(), JSON.stringify({ enabled: true }))
    expect(applyStoredTuning(dir)).toEqual([])
    expect(process.env.PSYCHE_BAND_CENTER_OFFSET).toBe('-0.35')
  })
})
