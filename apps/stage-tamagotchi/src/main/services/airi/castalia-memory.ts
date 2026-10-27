import type { createContext } from '@moeru/eventa/adapters/electron/main'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineInvokeHandler } from '@moeru/eventa'
import { createCastaliaMemoryRepository } from '@proj-airi/castalia-plugin/memory'
import { app } from 'electron'

import { castaliaMemoryForget, castaliaMemoryList, castaliaMemorySave } from '../../../shared/eventa/castalia-memory'
import { createCastaliaEngineMemory, resolveCastaliaEngineOptions } from './castalia-engine'

let repository: ReturnType<typeof createCastaliaMemoryRepository> | undefined
let repositoryPath: string | undefined

function getRepository(databasePath: string) {
  if (repository && repositoryPath !== databasePath)
    throw new Error('Castalia memory is already open at a different database path')
  if (!repository) {
    mkdirSync(dirname(databasePath), { recursive: true })
    const database = new DatabaseSync(databasePath)
    database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    repository = createCastaliaMemoryRepository(database)
    repositoryPath = databasePath
  }
  return repository
}

/**
 * Registers the durable memory backend on one renderer's Eventa context.
 *
 * Prefers the Castalia memory bank named by `castalia-engine.json` or the
 * `CASTALIA_*` environment variables, so the same bank serves every other client.
 * Falls back to the local `userData/castalia/memory.sqlite` when no engine is
 * configured. There is no built-in default path.
 */
export function setupCastaliaMemoryService(params: {
  context: ReturnType<typeof createContext>['context']
  databasePath: string
}) {
  const userDataDir = app.getPath('userData')
  const engineOptions = resolveCastaliaEngineOptions(userDataDir)
  if (engineOptions) {
    const engine = createCastaliaEngineMemory(engineOptions)
    console.info(`[castalia] memory backend: engine ${engineOptions.engineEntry} bank=${engineOptions.bankDir} project=${engineOptions.project}`)
    defineInvokeHandler(params.context, castaliaMemoryList, () => engine.list())
    defineInvokeHandler(params.context, castaliaMemorySave, entry => engine.save(entry))
    defineInvokeHandler(params.context, castaliaMemoryForget, entry => engine.forget(entry))
    app.once('before-quit', () => {
      void engine.close()
    })
    return
  }

  console.info(`[castalia] memory backend: local sqlite ${params.databasePath} (set castalia-engine.json to use the Castalia bank)`)
  const memory = getRepository(params.databasePath)
  defineInvokeHandler(params.context, castaliaMemoryList, () => memory.list())
  defineInvokeHandler(params.context, castaliaMemorySave, entry => memory.save(entry))
  defineInvokeHandler(params.context, castaliaMemoryForget, entry => memory.forget(entry))
}
