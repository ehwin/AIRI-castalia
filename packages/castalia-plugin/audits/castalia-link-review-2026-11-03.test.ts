import process from 'node:process'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { currentBank } from '@proj-airi/castalia-plugin/bank'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createInProcessBankMemory } from '../../../apps/stage-tamagotchi/src/main/services/airi/castalia-inprocess'

let adapter: ReturnType<typeof createInProcessBankMemory>

// These probes assert the audited defects. Passing does not mean that the defects are fixed.
describe('castalia link review: isolated engine', () => {
  beforeAll(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'airi-link-review-'))
    const config = join(directory, 'config.json')
    writeFileSync(config, '{}')
    for (const name of Object.keys(process.env).filter(name => name.startsWith('PSYCHE_') || name.startsWith('MEMORY_INJECT_')))
      vi.stubEnv(name, undefined)
    vi.stubEnv('MEMORY_DB_DIR', directory)
    vi.stubEnv('MEMORY_CONFIG', config)
    vi.stubEnv('CASTALIA_KEYS_FILE', join(directory, 'absent-keys.json'))
    vi.stubEnv('CASTALIA_KEY_FILE', join(directory, 'absent-key.json'))
    vi.stubEnv('EMBED_MODE', 'none')
    vi.stubEnv('MEMORY_AUTO_PROCESS', '0')
    adapter = createInProcessBankMemory({
      bankDir: directory,
      project: 'link-review',
      character: 'airi',
      engineEntry: 'unused-in-process',
      nodeBinary: process.execPath,
    })
    await adapter.list()
  })

  afterAll(async () => {
    await adapter?.close()
    vi.unstubAllEnvs()
  })

  // A01 (fixed): the adapter now hands the asking card to the recall, so the block carries that
  // card's rows instead of the character captured when the engine started.
  it('recalls the card the adapter was asked about, not the configured character', async () => {
    const marker = 'cardwiremarker'
    await adapter.save({ name: 'first-card', description: marker, body: `${marker} FIRST_CARD_SECRET`, persona: 'airi', updatedAt: 1 })
    await adapter.save({ name: 'second-card', description: marker, body: `${marker} SECOND_CARD_SECRET`, persona: 'second-card', updatedAt: 1 })

    const searched = await adapter.search!(marker, 5, 'second-card')
    expect(searched.some(hit => hit.text.includes('SECOND_CARD_SECRET'))).toBe(true)
    expect(searched.some(hit => hit.text.includes('FIRST_CARD_SECRET'))).toBe(false)

    const bank = currentBank()
    expect(bank).not.toBeNull()
    const explicit = await bank!.recallQuery(marker, { characterId: 'second-card' }) as { text: string, characterId: string }
    expect(explicit.characterId).toBe('second-card')
    expect(explicit.text).toContain('SECOND_CARD_SECRET')

    const implicit = await bank!.recallQuery(marker) as { text: string, characterId: string }
    expect(implicit.characterId).toBe('airi')
    const recalled = await adapter.recall!(marker, 'second-card')
    expect(recalled.text).toContain('SECOND_CARD_SECRET')
    expect(recalled.text).not.toContain('FIRST_CARD_SECRET')

    // The configured character still hears its own rows: the fix must not re-point everything.
    const first = await adapter.recall!(marker, 'airi')
    expect(first.text).toContain('FIRST_CARD_SECRET')
    expect(first.text).not.toContain('SECOND_CARD_SECRET')
  })
})
