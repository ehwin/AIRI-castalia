import { beforeEach, describe, expect, it } from 'vitest'

import { readScoped, removeScoped, scopedKey, writeScoped } from './persona-scope'

/** Minimal Storage, so the test never depends on a browser global. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('persona scope', () => {
  let storage: Storage

  beforeEach(() => {
    storage = memoryStorage()
  })

  it('keeps the base key global when there is no persona', () => {
    expect(scopedKey('diary/distilled', undefined)).toBe('diary/distilled')
    expect(scopedKey('diary/distilled', 'airi')).toBe('diary/distilled::airi')
  })

  // A diary and a pace are one character's own. Two cards must never read the same slice.
  it('writes and reads one slice per character', () => {
    writeScoped('diary/distilled', 'airi', ['2026-11-01'], storage)
    writeScoped('diary/distilled', 'yuno', ['2026-11-02'], storage)

    expect(readScoped('diary/distilled', 'airi', [], storage)).toEqual(['2026-11-01'])
    expect(readScoped('diary/distilled', 'yuno', [], storage)).toEqual(['2026-11-02'])
    expect(readScoped('diary/distilled', 'third', [], storage)).toEqual([])
  })

  // Before the split the value lived under the bare key. Exactly one character inherits it, so a day of one
  // character never shows up in another's diary.
  it('gives the legacy shared value to the first character only', () => {
    storage.setItem('diary/distilled', JSON.stringify(['2026-10-30']))

    expect(readScoped('diary/distilled', 'airi', [], storage)).toEqual(['2026-10-30'])
    expect(readScoped('diary/distilled', 'yuno', [], storage)).toEqual([])
  })

  it('removes only its own slice', () => {
    writeScoped('diary/distilled', 'airi', ['2026-11-01'], storage)
    writeScoped('diary/distilled', 'yuno', ['2026-11-02'], storage)

    removeScoped('diary/distilled', 'airi', storage)

    expect(readScoped('diary/distilled', 'airi', [], storage)).toEqual([])
    expect(readScoped('diary/distilled', 'yuno', [], storage)).toEqual(['2026-11-02'])
  })
})
