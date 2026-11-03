import type { BankHandle } from '@proj-airi/castalia-plugin/bank'

import process from 'node:process'

import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { currentBank } from '@proj-airi/castalia-plugin/bank'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createInProcessBankMemory } from '../../../apps/stage-tamagotchi/src/main/services/airi/castalia-inprocess'

const project = 'audit'
let bank: BankHandle
let adapter: ReturnType<typeof createInProcessBankMemory>
let emotion: typeof import('../src/vendor/engine/emotion')
let store: typeof import('../src/vendor/engine/store')
let database: typeof import('../src/vendor/engine/db')
let sensorServer: ReturnType<typeof createServer>
let sensorAvailable = false

// Engine imports must follow openBank. Production uses the same initialization boundary.
describe('castalia wiring audit: temporary bank', () => {
  beforeAll(async () => {
    const directory = mkdtempSync(join(tmpdir(), 'airi-wiring-audit-'))
    writeFileSync(join(directory, 'config.json'), '{}')
    for (const name of Object.keys(process.env).filter(name => name.startsWith('PSYCHE_')))
      vi.stubEnv(name, undefined)
    vi.stubEnv('MEMORY_DB_DIR', directory)
    vi.stubEnv('MEMORY_CONFIG', join(directory, 'config.json'))
    vi.stubEnv('CASTALIA_KEYS_FILE', join(directory, 'no-keys.json'))
    vi.stubEnv('CASTALIA_KEY_FILE', join(directory, 'no-key.json'))
    vi.stubEnv('EMBED_MODE', 'none')
    sensorServer = createServer((request, response) => {
      request.setEncoding('utf8')
      let body = ''
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        if (!sensorAvailable) {
          response.writeHead(503).end()
          return
        }
        const payload = JSON.parse(body) as { messages: { content: string }[] }
        const vad = { valence: 0.7, arousal: 0.5, dominance: 0.4 }
        const isClassifier = payload.messages[0].content.startsWith('Classify each numbered message')
        const count = payload.messages[1].content.match(/^\[\d+\]/gm)?.length ?? 0
        const content = isClassifier
          ? Array.from({ length: count }, () => ({ importance: 0.6, category: 'emotional', tags: ['audit'], vad }))
          : { vad, confidence: 0.9, tsundere_level: 0, tags: ['audit'] }
        response.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ message: { content: JSON.stringify(content) } }))
      })
    })
    await new Promise<void>(resolve => sensorServer.listen(0, '127.0.0.1', resolve))
    const address = sensorServer.address()
    if (!address || typeof address === 'string')
      throw new Error('The local audit sensor did not start')
    vi.stubEnv('OLLAMA_URL', `http://127.0.0.1:${address.port}`)
    vi.stubEnv('VAD_TIMEOUT_MS', '2000')
    vi.stubEnv('MEMORY_AUTO_PROCESS', '0')
    adapter = createInProcessBankMemory({
      bankDir: directory,
      project,
      character: 'airi',
      engineEntry: 'unused-in-process',
      nodeBinary: process.execPath,
    })
    await adapter.list()
    const opened = currentBank()
    if (!opened)
      throw new Error('The temporary bank did not open')
    bank = opened
    emotion = await import('../src/vendor/engine/emotion')
    store = await import('../src/vendor/engine/store')
    database = await import('../src/vendor/engine/db')
    console.info(`Audit bank: ${directory}`)
  })

  afterAll(async () => {
    vi.useRealTimers()
    await adapter?.close()
    database?.DatabaseManager.close()
    if (sensorServer)
      await new Promise<void>((resolve, reject) => sensorServer.close(error => error ? reject(error) : resolve()))
    vi.unstubAllEnvs()
  })

  // F01 (fixed): the adapter now opens a bank per character, so a lookup scoped to the card that
  // asks finds the card's own row. Without a persona it keeps the configured character, which is
  // what makes the two-card case explicit rather than accidental.
  it('searches the asking card when the caller passes its persona', async () => {
    await adapter.save({ name: 'second-card-fact', description: 'sapphireauditmarker', body: 'sapphireauditmarker belongs to the second card', persona: 'second-card', updatedAt: 1 })
    const entry = (await adapter.list()).find(entry => entry.name === 'second-card-fact')

    expect(entry?.persona).toBe('second-card')
    // No persona: the configured character, unchanged.
    expect(await adapter.search!('sapphireauditmarker')).toHaveLength(0)
    // The asking card's own scope finds it.
    const mine = await adapter.search!('sapphireauditmarker', 5, 'second-card')
    expect(mine).toEqual(expect.arrayContaining([expect.objectContaining({ id: entry?.id })]))
  })

  // F02 (fixed): the delete used to run through the configured character's bank and return false.
  it('deletes the second card row by its hydrated id', async () => {
    const entry = (await adapter.list()).find(entry => entry.name === 'second-card-fact')!

    expect(entry.id).toBeTruthy()
    expect(await adapter.forget(entry)).toBe(true)
    expect((await adapter.list()).some(row => row.id === entry.id)).toBe(false)
  })

  // F08 (fixed): the adapter used to hide the shared entries the list and the index show, so a
  // lookup answered "nothing matched" about a row the owner could see.
  it('includes general memories in the search tool, like the list and the index', async () => {
    await adapter.save({ name: 'shared-fact', description: 'emerldauditmarker', body: 'emerldauditmarker is shared', updatedAt: 1 })
    const entry = (await adapter.list()).find(entry => entry.name === 'shared-fact')

    expect(entry).toBeDefined()
    expect(entry?.persona).toBeUndefined()
    expect(await adapter.search!('emerldauditmarker')).toEqual(expect.arrayContaining([expect.objectContaining({ id: entry?.id })]))
  })

  it('writes an unscoped conversation into the configured character', async () => {
    const result = await adapter.ingest({ user: 'audit ingest marker', assistant: 'audit assistant marker' })
    const entry = (await adapter.list()).find(entry => entry.body.includes('audit ingest marker'))

    expect(result.ok).toBe(true)
    expect(entry?.persona).toBe('airi')
  })

  // F07 (fixed): the deadline now has its own trigger. `flushStaleVadQueue` is what the app's
  // two-minute sweep calls; it must leave a fresh batch alone and force an aged one.
  it('force-flushes a queue batch only once it is older than the deadline', async () => {
    vi.useFakeTimers()
    try {
      await store.saveConversationTurn('今天有点累，但挺好的。', '那就先歇一会儿。', 'airi', undefined, undefined, project)

      const fresh = await bank.flushStaleVadQueue(600)
      expect(fresh.updated).toBe(0)
      expect(fresh.pending).toBeGreaterThan(0)

      await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
      const aged = await bank.flushStaleVadQueue(600)
      expect(aged.updated).toBeGreaterThan(0)
      expect(aged.pending).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps one queued turn pending after eleven minutes without another flush caller', async () => {
    vi.useFakeTimers()
    try {
      await store.saveConversationTurn('谢谢你一直陪着我，我很开心。', '我也很开心。', 'timer-card', undefined, undefined, project)
      const flushed = await emotion.flushVadQueueDetailed(project, { force: false })

      expect(flushed.updated).toBe(0)
      expect(emotion.vadQueueStatus(project, 'timer-card').size).toBe(1)
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
      expect(emotion.vadQueueStatus(project, 'timer-card').oldestAgeSec).toBeGreaterThanOrEqual(660)
      expect(emotion.vadQueueStatus(project, 'timer-card').size).toBe(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('records local abstention and leaves psyche without evidence when the gate is unset', async () => {
    vi.stubEnv('PSYCHE_FROM_VAD', undefined)
    const saved = await store.saveConversationTurn('谢谢你，我很开心，我信任你。', '我也很开心。', 'gate-off-card', undefined, undefined, project)
    const flushed = await emotion.flushVadQueueDetailed(project, { force: true })
    const row = database.DatabaseManager.getInstance(project).prepare('SELECT affect_status, affect_source FROM memory WHERE id = ?').get(saved.id)

    expect(flushed.updated).toBeGreaterThan(0)
    expect(flushed.source).toBe('local')
    expect(row?.affect_status).toBe('abstain')
    expect(row?.affect_source).toBe('local_lexicon')
    expect((await bank.psycheState({ characterId: 'gate-off-card' })).hasEvidence).toBe(false)
  })

  it('still abstains with the local lexicon when the separate gate is explicitly on', async () => {
    vi.stubEnv('PSYCHE_FROM_VAD', 'on')
    await store.saveConversationTurn('谢谢你，我很开心，我信任你。', '我也很开心。', 'gate-on-card', undefined, undefined, project)
    const flushed = await emotion.flushVadQueueDetailed(project, { force: true })
    const psyche = await bank.psycheState({ characterId: 'gate-on-card' })

    expect(flushed.updated).toBeGreaterThan(0)
    expect(flushed.source).toBe('local')
    expect(psyche.hasEvidence).toBe(false)
  })

  it('writes valid model VAD but leaves psyche without evidence when its gate is unset', async () => {
    sensorAvailable = true
    vi.stubEnv('PSYCHE_FROM_VAD', undefined)
    const saved = await store.saveConversationTurn('谢谢你，我很开心，我信任你。', '我也很开心。', 'model-off-card', undefined, undefined, project)
    const flushed = await emotion.flushVadQueueDetailed(project, { force: true })
    const row = database.DatabaseManager.getInstance(project).prepare('SELECT affect_status, affect_source FROM memory WHERE id = ?').get(saved.id)

    expect(flushed.updated).toBe(1)
    expect(flushed.source).toBe('ollama')
    expect(row?.affect_status).toBe('analyzed')
    expect((await bank.psycheState({ characterId: 'model-off-card' })).hasEvidence).toBe(false)
  })

  it('advances psyche with the same model response when its gate is explicitly on', async () => {
    vi.stubEnv('PSYCHE_FROM_VAD', 'on')
    await store.saveConversationTurn('谢谢你，我很开心，我信任你。', '我也很开心。', 'model-on-card', undefined, undefined, project)
    const flushed = await emotion.flushVadQueueDetailed(project, { force: true })
    const psyche = await bank.psycheState({ characterId: 'model-on-card' })

    expect(flushed.updated).toBe(1)
    expect(flushed.source).toBe('ollama')
    expect(psyche.hasEvidence).toBe(true)
  })
})
