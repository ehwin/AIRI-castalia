import { describe, expect, it } from 'vitest'

import { buildMemoryBlock, hitLine } from './memory-block'

describe('memoryBlock', () => {
  it('tags each line with its kind and keeps coordinates verbatim', () => {
    const line = hitLine({ text: '# 地点: 主屋\nx 120 y 64 z -330', category: 'mc:place' })

    expect(line).toBe('- [place] # 地点: 主屋 x 120 y 64 z -330')
  })

  it('answers empty for no hits, so the caller can skip the injection', () => {
    expect(buildMemoryBlock([])).toBe('')
    expect(buildMemoryBlock([{ text: '  ' }])).toBe('')
  })

  it('names the world and points at the tools', () => {
    const block = buildMemoryBlock(
      [{ text: '# 计划: 造桥', category: 'mc:plan' }],
      { world: 'localhost:25565' },
    )

    expect(block).toContain('[MEMORY] 游戏记忆 · localhost:25565')
    expect(block).toContain('- [plan] # 计划: 造桥')
    expect(block).toContain('recallMemory')
    expect(block).toContain('remember')
  })

  it('caps the block at twelve rows', () => {
    const hits = Array.from({ length: 20 }, (_, index) => ({ text: `# 事件: ${index}`, category: 'mc:event' }))
    const block = buildMemoryBlock(hits)

    expect(block.split('\n').filter(line => line.startsWith('- [event]'))).toHaveLength(12)
  })

  it('says which query produced the block', () => {
    const block = buildMemoryBlock([{ text: '# 地点: 矿井', category: 'mc:place' }], { query: '矿井在哪' })

    expect(block).toContain('矿井在哪')
  })
})
