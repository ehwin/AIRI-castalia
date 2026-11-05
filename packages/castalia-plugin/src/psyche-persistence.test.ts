import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { openBank } from './bank'

afterEach(() => vi.unstubAllEnvs())

// ROOT CAUSE:
// Database reads discarded the event's frozen decay multiplier.
// Persisting the multiplier keeps durable transitions equal to in-memory transitions after tuning changes.
it('preserves the event decay rate through a durable state read', async () => {
  const bankDir = mkdtempSync(join(tmpdir(), 'castalia-psyche-'))
  const bank = await openBank({ bankDir, project: 'psyche-test', charId: 'airi', allowNoConfig: true })
  const { DatabaseManager } = await import('./vendor/engine/db')
  try {
    // The bank sets the engine environment before these modules load.
    const { applyPsycheAppraisal, transitionPsycheState } = await import('./vendor/engine/psycheState')
    const now = Date.UTC(2026, 10, 5)
    vi.stubEnv('PSYCHE_NEGATIVE_PERSISTENCE', '1.6')
    const appraisal = { kind: 'target', target: { valence: -0.5 }, eventId: 'frozen-decay' } as const
    const initial = applyPsycheAppraisal('airi', 'psyche-test', appraisal, now, { requirePersistence: true })
    vi.stubEnv('PSYCHE_NEGATIVE_PERSISTENCE', '3')
    const nextAt = now + 4 * 3_600_000
    const expected = transitionPsycheState(initial, appraisal, nextAt)
    const actual = applyPsycheAppraisal('airi', 'psyche-test', appraisal, nextAt, { requirePersistence: true })

    expect(actual.vad.valence).toBeCloseTo(expected.vad.valence, 12)
    expect(actual.valenceBias).toBe(initial.valenceBias)
    expect(actual.version).toBe(initial.version)
  }
  finally {
    DatabaseManager.close()
    bank.close()
    rmSync(bankDir, { recursive: true, force: true })
  }
})
