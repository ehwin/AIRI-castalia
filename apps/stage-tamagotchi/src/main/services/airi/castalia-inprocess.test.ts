import { describe, expect, it } from 'vitest'
import { parseBankTime } from '@proj-airi/castalia-plugin/bank/time'

// The real `memory.sqlite` hands back `updated_at` as INTEGER for some rows and TEXT for others
// (measured on the live bank: 254 integer, 42 text in one category). The old helper called
// `value.includes('T')` unconditionally, so one integer row made the whole list throw and the
// renderer's hydrate fall back to a stale local cache — invisible to every mocked-port test.
describe('parseBankTime', () => {
  it('reads seconds and milliseconds epochs', () => {
    expect(parseBankTime(1_793_695_596)).toBe(1_793_695_596_000)
    expect(parseBankTime(1_793_695_596_000)).toBe(1_793_695_596_000)
    expect(parseBankTime('1793695596')).toBe(1_793_695_596_000)
  })

  it('reads the SQLite datetime and ISO forms', () => {
    const fromSql = parseBankTime('2026-11-03 09:00:00')
    const fromIso = parseBankTime('2026-11-03T09:00:00.000Z')
    expect(fromSql).toBe(Date.parse('2026-11-03T09:00:00Z'))
    expect(Math.abs(fromIso - Date.parse('2026-11-03T09:00:00Z'))).toBeLessThan(1_000)
  })

  it('falls back to now instead of throwing on empty or junk', () => {
    const before = Date.now()
    for (const value of [undefined, null, '', 'not a date']) {
      const parsed = parseBankTime(value as string | number | null | undefined)
      expect(Number.isFinite(parsed)).toBe(true)
      expect(parsed).toBeGreaterThanOrEqual(before - 1_000)
    }
  })
})
