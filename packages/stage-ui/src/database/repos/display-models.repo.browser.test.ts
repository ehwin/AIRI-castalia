import type { DisplayModelFile } from '../../stores/display-models'

import localforage from 'localforage'

import { afterEach, expect, it } from 'vitest'

import { DisplayModelFormat } from '../../stores/display-models'
import { createDisplayModelsRepo } from './display-models.repo'

// Browser test files share one origin and one IndexedDB. Remove only the keys that this test writes.
const store = localforage.createInstance({ name: 'airi-display-models-browser-test' })
const id = 'display-model-browser-test'

function bytes(size: number) {
  const data = new Uint8Array(size)
  for (let index = 0; index < size; index++)
    data[index] = (index * 31 + 7) % 251
  return data
}

afterEach(async () => {
  await store.removeItem(id)
})

it('reads a model that the previous release wrote, with the same bytes', async () => {
  const content = bytes(64 * 1024)
  await store.setItem(id, {
    format: DisplayModelFormat.VRM,
    file: new File([content], 'avatar.vrm', { type: 'model/gltf-binary' }),
    importedAt: 1,
  })

  const [listed] = await createDisplayModelsRepo(store).list()

  expect(listed).toMatchObject({ id, type: 'file', name: 'avatar.vrm', format: DisplayModelFormat.VRM })
  expect(new Uint8Array(await listed.file.arrayBuffer())).toEqual(content)
})

it('keeps a saved model across repository instances', async () => {
  const model: DisplayModelFile = { id, format: DisplayModelFormat.Live2dZip, type: 'file', file: new File(['zip'], 'model.zip'), name: 'Renamed', importedAt: 1 }
  await createDisplayModelsRepo(store).save(model)

  const repo = createDisplayModelsRepo(store)

  expect(await repo.list()).toMatchObject([{ id, name: 'Renamed' }])
  expect(await (await repo.get(id))!.file.text()).toBe('zip')
})
