import type { createContext } from '@moeru/eventa/adapters/electron/main'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { defineInvokeHandler } from '@moeru/eventa'
import { createCastaliaMemoryRepository } from '@proj-airi/castalia-plugin/memory'
import { app } from 'electron'

import { castaliaMemoryForget, castaliaMemoryList, castaliaMemoryRecall, castaliaMemorySave } from '../../../shared/eventa/castalia-memory'
import { createCastaliaEngineMemory, resolveCastaliaEngineOptions } from './castalia-engine'
import { createInProcessBankMemory } from './castalia-inprocess'

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
    // 默认在主进程内直连记忆库（不再 spawn 子进程、不走 MCP/HTTP）；
    // CASTALIA_MEMORY_TRANSPORT=stdio 可切回旧的子进程路径做对照/兜底。
    const transport = process.env.CASTALIA_MEMORY_TRANSPORT === 'stdio' ? 'stdio' : 'in-process'
    const engine = transport === 'in-process'
      ? createInProcessBankMemory(engineOptions)
      : createCastaliaEngineMemory(engineOptions)
    console.info(`[castalia] memory backend: ${transport} bank=${engineOptions.bankDir} project=${engineOptions.project}`)
    defineInvokeHandler(params.context, castaliaMemoryList, () => engine.list())
    defineInvokeHandler(params.context, castaliaMemorySave, entry => engine.save(entry))
    defineInvokeHandler(params.context, castaliaMemoryForget, entry => engine.forget(entry))
    defineInvokeHandler(params.context, castaliaMemoryRecall, query => engine.recall(query))
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
  // The local repository holds entries only, so a recall has no ranked text to render.
  defineInvokeHandler(params.context, castaliaMemoryRecall, () => ({ text: '', count: 0, topSim: 0, chars: 0 }))
}
