import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { useProviderConfigStore } from './config'

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

vi.mock('../../libs/providers', () => ({
  getDefinedProvider: vi.fn((id: string) => id === 'openai-compatible'
    ? { id: 'openai-compatible', name: 'OpenAI Compatible' }
    : undefined),
}))

function installStore() {
  const app = createApp({})
  const pinia = createPinia()
  app.use(pinia)
  setActivePinia(pinia)
  return useProviderConfigStore()
}

describe('provider config store', () => {
  beforeEach(() => {
    const storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      localStorage: storage,
      removeEventListener: vi.fn(),
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps a provider configuration on this device', () => {
    const store = installStore()

    const provider = store.ensureProvider('local-provider', 'openai-compatible', { apiKey: 'sk-local' })
    store.setProviderStatus('local-provider', 'configured')

    expect(provider.id).toBe('local-provider')
    expect(store.getProviderConfig('local-provider')).toEqual({ apiKey: 'sk-local' })
    expect(store.configs['local-provider']).toEqual({ apiKey: 'sk-local' })
    expect(store.configuredProviders['local-provider']).toBe(true)
  })

  it('rejects a provider definition that is not registered', () => {
    const store = installStore()

    expect(() => store.ensureProvider('local-provider', 'missing-definition')).toThrow('Provider definition with id "missing-definition" not found.')
  })

  it('keeps unrelated configuration fields when it applies a patch', async () => {
    const store = installStore()
    store.ensureProvider('local-provider', 'openai-compatible', { apiKey: 'sk-local', model: 'gpt-5' })

    await expect(store.patchProviderConfig('local-provider', { api: 'responses' })).resolves.toBe(true)
    expect(store.getProviderConfig('local-provider')).toEqual({ apiKey: 'sk-local', model: 'gpt-5', api: 'responses' })

    await expect(store.patchProviderConfig('missing', { api: 'responses' })).resolves.toBe(false)
  })

  it('seeds a discovered default model without replacing a user selection', async () => {
    const store = installStore()
    store.ensureProvider('local-provider', 'openai-compatible', { apiKey: 'sk-local' })

    await store.setProviderModelIfUnset('local-provider', 'gpt-5')
    expect(store.getProviderConfig('local-provider')?.model).toBe('gpt-5')

    await store.setProviderModel('local-provider', 'gpt-5-mini')
    await store.setProviderModelIfUnset('local-provider', 'gpt-5')
    expect(store.getProviderConfig('local-provider')?.model).toBe('gpt-5-mini')
  })

  it('removes a provider and its added flag together', async () => {
    const store = installStore()

    const provider = await store.addProvider('openai-compatible')
    expect(store.listedProviders[provider.id]).toBeDefined()

    await store.removeProvider(provider.id)

    expect(store.getProvider(provider.id)).toBeUndefined()
    expect(store.listedProviders[provider.id]).toBeUndefined()
  })

  it('resets every stored provider', async () => {
    const store = installStore()
    await store.addProvider('openai-compatible')

    await store.resetProviders()

    expect(store.providers).toEqual({})
    expect(store.addedProviders).toEqual({})
  })
})
