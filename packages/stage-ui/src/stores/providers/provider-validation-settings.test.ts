import { PiniaColada } from '@pinia/colada'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { useProviderConfigStore } from './config'
import { useProviderStore } from './provider'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ locale: { value: 'en' }, t: (key: string) => key }),
  // `useProviderStore` builds provider metadata with `selectProvidersMetadata`,
  // which translates each entry through the same mock. A numeric key needs no
  // lookup, so the stub covers it.
  createI18n: () => ({ global: { t: (key: string) => key } }),
}))

vi.mock('localforage', () => ({
  default: {
    getItem: vi.fn(async () => undefined),
    iterate: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
    setItem: vi.fn(async <T>(_: string, value: T) => value),
  },
}))

const providerId = 'browser-web-speech-api'

describe('provider checks for the settings pages', () => {
  beforeEach(() => {
    const pinia = createPinia()
    createApp({}).use(pinia).use(PiniaColada)
    setActivePinia(pinia)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ recommended: {}, voices: [], data: [] }))))
  })

  afterEach(() => vi.unstubAllGlobals())

  // ROOT CAUSE:
  //
  // Every provider settings page calls `validateProviderSettings` and
  // `recordUnfinishedConfig` through `useProviderValidation`. The vendor upgrade
  // to 0.13.1 dropped both actions from this store, so each page threw
  // "not a function". The package typecheck was already red, so nothing caught it.
  it('exposes the actions that the provider settings pages call', async () => {
    const providers = useProviderStore()
    await providers.initializeProvider(providerId)

    expect(typeof providers.validateProviderSettings).toBe('function')
    expect(typeof providers.recordUnfinishedConfig).toBe('function')
  })

  it('records the outcome of a settings check for the failure notices', async () => {
    const providers = useProviderStore()
    await providers.initializeProvider(providerId)

    const result = await providers.validateProviderSettings(providerId, {})
    const runtimeState = providers.providerRuntimeState[providerId]
    const status = useProviderConfigStore().providers[providerId]?.status

    expect(result).toHaveProperty('valid')
    expect(runtimeState.validationOutcome).toBe(status)
    expect(runtimeState.validationTimes).toHaveLength(1)
    if (result.valid)
      expect(runtimeState.validationReason).toBeUndefined()
    else
      expect(runtimeState.validationReason).toBe(result.reason)
  })

  it('records an unfinished config as unconfigured, without a failure reason', async () => {
    const providers = useProviderStore()
    await providers.initializeProvider(providerId)
    await providers.validateProviderSettings(providerId, {})
    await providers.recordUnfinishedConfig(providerId)

    expect(providers.providerRuntimeState[providerId].validationOutcome).toBe('unconfigured')
    expect(providers.providerRuntimeState[providerId].validationReason).toBeUndefined()
    expect(useProviderConfigStore().providers[providerId]?.status).toBe('unconfigured')
  })
})
