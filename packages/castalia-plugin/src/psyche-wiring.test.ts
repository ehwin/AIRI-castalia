// 接线测试：flush 层的两处修复（证据时间戳 / 同秒合并 / 重要性→salience）。
//
// 背景（R1）：一次 flush 里同一秒的 5 个 chunk 各自以 gain 朝自己的目标走一步，
// 最后一条把前面全盖掉；而 importance 从来没进过 applyPsycheAppraisal，
// 「重要的事持续更久」只在单测里成立。这里钉住的是**接线**而不是数字。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { batchEvidenceNow, mergeSameMomentBatches, salienceFromEvidence } from './vendor/engine/emotion'

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0)
const entry = (seconds: number, id = 'e') => ({ text: id, timestamp: T0 + seconds * 1000, project: 'p', characterId: 'c', memoryId: id })

describe('证据时间戳：用证据的时间推进，不用墙钟', () => {
  it('取批内最新的 timestamp', () => {
    expect(batchEvidenceNow([entry(0), entry(30), entry(7)], T0)).toBe(T0 + 30_000)
  })

  it('没有可用时间戳时退回 fallback', () => {
    expect(batchEvidenceNow([{ timestamp: Number.NaN }], T0)).toBe(T0)
    expect(batchEvidenceNow([], T0)).toBe(T0)
  })
})

describe('同秒合并：同一时刻的多条证据是一个观测', () => {
  const batch = (secs: number[], project = 'p', characterId = 'c') => ({
    project,
    characterId,
    entries: secs.map((s, i) => entry(s, `m${i}`)),
  })

  it('同一秒的 5 个 chunk 合并成 1 个，条目全在', () => {
    const chunks = [batch([0, 0, 0]), batch([0, 0])]
    const merged = mergeSameMomentBatches(chunks, T0)
    expect(merged).toHaveLength(1)
    expect(merged[0].entries).toHaveLength(5)
  })

  it('不同秒的 chunk 保持分开（一条一句地变）', () => {
    const merged = mergeSameMomentBatches([batch([0]), batch([5]), batch([40])], T0)
    expect(merged).toHaveLength(3)
  })

  it('不同角色/项目永不合并', () => {
    const merged = mergeSameMomentBatches([batch([0], 'p', 'c1'), batch([0], 'p', 'c2'), batch([0], 'q', 'c1')], T0)
    expect(merged).toHaveLength(3)
  })

  it('合并不修改传入的批对象（可安全重试）', () => {
    const a = batch([0, 0])
    const before = a.entries.length
    mergeSameMomentBatches([a, batch([0])], T0)
    expect(a.entries.length).toBe(before)
  })
})

describe('salience 标度：importance 是 0..1，emotional_impact 是 0..10', () => {
  it('impact 必须先除以 10，否则任何 impact≥1 都钉死 1.0', () => {
    expect(salienceFromEvidence(0.5, 5.7)).toBeCloseTo(0.57, 10)
    expect(salienceFromEvidence(0.3, 0)).toBeCloseTo(0.3, 10)
    expect(salienceFromEvidence(0, 3.3)).toBeCloseTo(0.33, 10)
  })

  it('取二者较大者并夹在 0..1', () => {
    expect(salienceFromEvidence(0.9, 2)).toBeCloseTo(0.9, 10)
    expect(salienceFromEvidence(0.2, 20)).toBe(1)
    expect(salienceFromEvidence(undefined, undefined)).toBe(0)
    expect(salienceFromEvidence(-1, -5)).toBeCloseTo(0.5, 10)
  })
})

describe('生产接线：两个 appraisal 调用点都必须带 salience 与证据时间', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, 'vendor/engine/emotion.ts'), 'utf8')

  it('词表路径与模型路径都传 salience', () => {
    const hits = source.match(/salience:\s*batchSalience\(/g) || []
    expect(hits.length).toBe(2)
  })

  it('两个调用点都不再用裸 Date.now() 推进状态', () => {
    const evidenceNow = source.match(/batchEvidenceNow\(batch\.entries,\s*now\)/g) || []
    expect(evidenceNow.length).toBe(2)
  })
})
