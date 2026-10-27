import localforage from 'localforage'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DisplayModelFormat, useDisplayModelsStore } from './display-models'

vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async () => undefined),
    iterate: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    setItem: vi.fn(async (_key: string, value: unknown) => value),
  },
}))

describe('display models store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('resolves newly imported display models from memory before IndexedDB', async () => {
    const store = useDisplayModelsStore()
    const model = {
      id: 'display-model-pending-idb-write',
      format: DisplayModelFormat.Live2dZip,
      type: 'file' as const,
      file: new File(['model'], 'model.zip'),
      name: 'model.zip',
      importedAt: 1,
    }

    store.displayModels = [model]

    const resolved = await store.getDisplayModel(model.id)

    expect(resolved).toEqual(model)
  })

  it('resolves a built-in preset from the catalog', async () => {
    const store = useDisplayModelsStore()

    await expect(store.getDisplayModel('preset-vrm-1')).resolves.toMatchObject({ id: 'preset-vrm-1', type: 'url' })
    await expect(store.getDisplayModel('missing-model')).resolves.toBeUndefined()
  })

  it('reports a removed model to the listeners', async () => {
    const store = useDisplayModelsStore()
    store.displayModels = [{
      id: 'display-model-local',
      format: DisplayModelFormat.Live2dZip,
      type: 'file',
      file: new File(['model'], 'model.zip'),
      name: 'model.zip',
      importedAt: 1,
    }]
    const deleted = vi.fn()
    store.onDisplayModelsDeleted(deleted)

    await store.removeDisplayModel('display-model-local')

    expect(deleted).toHaveBeenCalledWith(['display-model-local'])
    expect(store.displayModels.some(model => model.id === 'display-model-local')).toBe(false)
    expect(localforage.removeItem).toHaveBeenCalledWith('display-model-local')
  })

  it('loads stored models once when several callers initialize at the same time', async () => {
    const store = useDisplayModelsStore()

    await Promise.all([
      store.loadDisplayModelsFromIndexedDB(),
      store.loadDisplayModelsFromIndexedDB(),
      store.loadDisplayModelsFromIndexedDB(),
    ])

    expect(localforage.iterate).toHaveBeenCalledTimes(1)
  })
})
