import type { MemoryEntry } from './memory'

import { describe, expect, it } from 'vitest'

import bank from './fixtures/bank.sample.json'

import { buildMemoryIndex, INDEX_MAX_CHARS, selectIndexEntries } from './memory'

const entries = bank.entries as MemoryEntry[]
const NOW = new Date('2026-11-03T12:00:00+08:00').getTime()

/** The three section bodies, keyed by their heading. */
function sections(index: string) {
  const out: Record<string, string[]> = {}
  let current = ''
  for (const line of index.split('\n')) {
    if (line.endsWith(':')) {
      current = line.slice(0, -1)
      out[current] = []
    }
    else if (line.startsWith('- ') && current) {
      out[current].push(line.slice(2))
    }
  }
  return out
}

describe('memory index on a shaped bank', () => {
  const index = buildMemoryIndex(entries, NOW)

  // The bank holds 8 lore facts, 3 owner facts, 4 dated summaries, 3 transcripts, one mood
  // label and two near copies. The index is a map built from that mix, not its transcript.
  it('splits her facts, the owner facts and the recent moments', () => {
    const parts = sections(index)

    expect(Object.keys(parts)).toEqual(['About you', 'About the owner', 'Recent'])
    expect(parts['About you']!.length).toBeGreaterThan(3)
    expect(parts['About the owner']!.length).toBeGreaterThanOrEqual(2)
    expect(parts.Recent!.length).toBeGreaterThanOrEqual(2)
  })

  it('never shows a turn transcript, a stale mood label or a generated id', () => {
    expect(index).not.toContain('用户: 在吗')
    expect(index).not.toContain('User: good night')
    expect(index).not.toContain('情绪快照')
    expect(index).not.toMatch(/mem-[0-9a-z]{4,}/)
  })

  it('keeps the anchors a persona must not lose', () => {
    // Her own facts stay hers, the owner's birthday resolution stays with him.
    expect(sections(index)['About you']!.join('\n')).toContain('名字来自一次月食')
    expect(sections(index)['About you']!.join('\n')).toContain('母亲')
    expect(sections(index)['About the owner']!.join('\n')).toContain('生日')
  })

  it('collapses a paraphrase and keeps one line per day', () => {
    const you = sections(index)['About you']!.join('\n')
    expect(you.match(/北边的港城/g)?.length).toBe(1)

    const recent = sections(index).Recent!.join('\n')
    expect(recent.match(/2026-10-30/g)?.length).toBe(1)
  })

  it('stays inside the prompt budget and renders the same bytes twice', () => {
    expect(index.length).toBeLessThanOrEqual(INDEX_MAX_CHARS)
    expect(buildMemoryIndex(entries, NOW)).toBe(index)
  })

  it('leaves the sections usable when a bank is almost empty', () => {
    const one: MemoryEntry[] = [{ name: 'mem-1111aaaa', description: '我记得窗台上有一只旧杯子。', body: '', updatedAt: NOW }]
    expect(buildMemoryIndex(one, NOW)).toBe('About you:\n- 我记得窗台上有一只旧杯子。')
    expect(buildMemoryIndex([], NOW)).toBe('')
  })

  it('reports what it dropped, so a caller can explain an empty section', () => {
    const onlyTranscripts = entries.filter(entry => ['mem-e5f6a7b8', 'mem-f6a7b8c9', 'mem-a7b8c9d0'].includes(entry.name))
    const picked = selectIndexEntries(onlyTranscripts, NOW)

    expect(picked.her).toHaveLength(0)
    expect(picked.owner).toHaveLength(0)
    expect(picked.recent).toHaveLength(0)
  })
})
