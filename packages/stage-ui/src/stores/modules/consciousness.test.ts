// @vitest-environment jsdom
import { streamFrom } from '@proj-airi/core-agent'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useProviderConfigStore } from '../providers/config'
import { useProviderStore } from '../providers/provider'
import { useConsciousnessStore } from './consciousness'
import { useConsciousnessSettingsStore } from './consciousness-settings'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: { value: 'en-US' },
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('consciousness store provider selection', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  // ROOT CAUSE:
  // Default slider values were sent even when users had never configured sampling.
  // Explicit opt-in now separates saved values from active request parameters.
  // https://github.com/moeru-ai/airi/issues/2628
  it('leaves sampling parameters unset by default (Issue #2628)', () => {
    const store = useConsciousnessStore()

    expect(store.activeTemperature).toBeUndefined()
    expect(store.activeTopP).toBeUndefined()
  })

  it('does not treat previously saved sampling values as opt-in (Issue #2628)', () => {
    localStorage.setItem('settings/consciousness/active-temperature', '0.3')
    localStorage.setItem('settings/consciousness/active-top-p', '0.8')
    const store = useConsciousnessStore()

    expect(store.activeTemperature).toBeUndefined()
    expect(store.activeTopP).toBeUndefined()
  })

  it('sends only enabled sampling parameters and preserves zero values', async () => {
    const store = useConsciousnessStore()
    const settings = useConsciousnessSettingsStore()
    store.temperature = 0
    store.topP = 0.8
    const requests: Record<string, unknown>[] = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    async function send() {
      await streamFrom({
        model: 'test',
        chatProvider: { generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.test/v1/', fetch } }) },
        conversation: { turns: [] },
        options: { temperature: store.activeTemperature, topP: store.activeTopP },
      })
    }

    await send()
    expect(requests[0]).not.toHaveProperty('temperature')
    expect(requests[0]).not.toHaveProperty('top_p')

    await settings.setTemperatureEnabled(true)
    await send()
    expect(requests[1].temperature).toBe(0)
    expect(requests[1]).not.toHaveProperty('top_p')

    await settings.setTemperatureEnabled(false)
    await settings.setTopPEnabled(true)
    await send()
    expect(requests[2]).not.toHaveProperty('temperature')
    expect(requests[2].top_p).toBe(0.8)

    await settings.setTopPEnabled(false)
    await send()
    expect(requests[3]).not.toHaveProperty('temperature')
    expect(requests[3]).not.toHaveProperty('top_p')
    expect(store.temperature).toBe(0)
    expect(store.topP).toBe(0.8)
  })

  it('restores explicit sampling opt-in and clears it when reset', async () => {
    localStorage.setItem('settings/consciousness/temperature-enabled', 'true')
    localStorage.setItem('settings/consciousness/top-p-enabled', 'true')
    localStorage.setItem('settings/consciousness/active-temperature', '0')
    localStorage.setItem('settings/consciousness/active-top-p', '0.8')
    const store = useConsciousnessStore()

    expect(store.activeTemperature).toBe(0)
    expect(store.activeTopP).toBe(0.8)

    await store.resetState()

    expect(store.activeTemperature).toBeUndefined()
    expect(store.activeTopP).toBeUndefined()
    expect(localStorage.getItem('settings/consciousness/temperature-enabled')).toBe('false')
    expect(localStorage.getItem('settings/consciousness/top-p-enabled')).toBe('false')
  })

  // ROOT CAUSE:
  //
  // supportsModelListing called a throwing metadata lookup for unknown ids.
  // With no provider selected yet (fresh install or reset state persists ''),
  // evaluating the computed surfaced a raw "Provider metadata for  not found"
  // error to the user.
  //
  // We fixed this by checking the ProviderDefinition registry through the
  // runtime store without building executable ProviderMetadata objects.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('reports no model listing support instead of throwing when no provider is selected (Issue #1761)', () => {
    const store = useConsciousnessStore()

    expect(store.activeProvider).toBe('')
    expect(() => store.supportsModelListing).not.toThrow()
    expect(store.supportsModelListing).toBe(false)
  })

  it('reports no model listing support for a stale provider id that no longer exists (Issue #1761)', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'provider-deleted-long-ago'

    expect(() => store.supportsModelListing).not.toThrow()
    expect(store.supportsModelListing).toBe(false)
  })

  it('findProviderDefinition returns known provider definitions', () => {
    const providersStore = useProviderStore()

    const definition = providersStore.findProviderDefinition('openai')

    expect(definition).toBeDefined()
    expect(definition?.id).toBe('openai')
  })

  it('findProviderDefinition returns undefined for empty and unknown ids', () => {
    const providersStore = useProviderStore()

    expect(providersStore.findProviderDefinition('')).toBeUndefined()
    expect(providersStore.findProviderDefinition('nope')).toBeUndefined()
  })

  it('resolves definitions through a configured provider instance id', () => {
    const providerStore = useProviderConfigStore()
    const providersStore = useProviderStore()
    providerStore.ensureProvider('custom-openai', 'openai', { apiKey: 'sk-test' })

    const definition = providersStore.findProviderDefinition('custom-openai')

    expect(definition?.id).toBe('openai')
    expect(definition?.name).toBe('OpenAI')
  })

  it('resolves chat providers with the current reasoning mode', async () => {
    const providerConfigStore = useProviderConfigStore()
    providerConfigStore.ensureProvider('openai', 'openai', { apiKey: 'sk-test' })
    const consciousnessStore = useConsciousnessStore()
    const settingsStore = useConsciousnessSettingsStore()

    const disabledProvider = await consciousnessStore.getChatProviderInstance('openai')
    // The provider only sends efforts supported by the selected catalog model.
    expect(disabledProvider.generation('gpt-5.1').config).toMatchObject({ reasoning: { effort: 'none' } })

    await settingsStore.setReasoning(true)

    const enabledProvider = await consciousnessStore.getChatProviderInstance('openai')
    expect(enabledProvider.generation('gpt-5.1').config).toMatchObject({ reasoning: { effort: 'medium', summary: 'auto' } })
    expect(enabledProvider.generation('test-model').config).not.toHaveProperty('reasoning')
  })

  // https://github.com/moeru-ai/airi/issues/2816
  // ROOT CAUSE:
  //
  // OpenRouter requests omit the reasoning override when the catalog has no
  // entry for the selected model, but the settings page still showed a toggle.
  // We fixed this by exposing the provider-default state and showing it in the UI.
  it('uses the OpenRouter default for a model that is missing from the catalog (Issue #2816)', async () => {
    const providerConfigStore = useProviderConfigStore()
    providerConfigStore.ensureProvider('openrouter-ai', 'openrouter-ai', { apiKey: 'test-key' })
    const consciousnessStore = useConsciousnessStore()
    consciousnessStore.activeProvider = 'openrouter-ai'
    consciousnessStore.activeModel = 'uncatalogued-model'

    expect(consciousnessStore.activeModelUsesProviderReasoningDefault).toBe(true)

    const provider = await consciousnessStore.getChatProviderInstance('openrouter-ai')
    expect(provider.generation('uncatalogued-model').config).not.toHaveProperty('reasoning')
  })

  // ROOT CAUSE:
  //
  // The model selection was only cleared on provider switches by a watcher in
  // the consciousness settings page. Provider changes made anywhere else
  // (onboarding, character cards, provider deletion) kept the previous
  // provider's model id, and the next chat request failed upstream with
  // 404 model_not_found (e.g. "Model gpt-oss-120b does not exist").
  //
  // We fixed this by moving the reset into the store itself, next to the
  // state it protects.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('clears the model selection when the provider changes (Issue #1761)', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'cerebras'
    store.activeModel = 'gpt-oss-120b'
    store.customModelName = 'custom-name'

    store.activeProvider = 'openai'

    expect(store.activeModel).toBe('')
    expect(store.customModelName).toBe('')
  })

  it('clears the model synchronously so callers can set a new one right after', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'cerebras'
    store.activeModel = 'gpt-oss-120b'

    // The set-provider-then-set-model sequence used by auth provider sync and
    // character cards must keep the newly assigned model.
    store.activeProvider = 'official-provider'
    store.activeModel = 'auto'

    expect(store.activeModel).toBe('auto')
  })

  it('keeps the persisted model when the provider stays the same', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'openai'
    store.activeModel = 'gpt-4o-mini'

    store.activeProvider = 'openai'

    expect(store.activeModel).toBe('gpt-4o-mini')
  })

  // ROOT CAUSE:
  //
  // The store used Pinia synchronization and storage event synchronization
  // for the same state. An incoming Pinia snapshot changed the provider and
  // reset the model. A stale storage event then restored the previous model.
  // Both windows published each reflected change and created an endless loop.
  //
  // We fixed this by keeping localStorage as one-way persistence. Pinia is the
  // only channel that can update live state across windows.
  it('does not apply storage events as a second cross-window state channel', async () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'official-provider'
    store.activeModel = 'auto'
    await nextTick()

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'settings/consciousness/active-model',
      newValue: '',
      storageArea: localStorage,
    }))
    await nextTick()
    await nextTick()

    expect(store.activeModel).toBe('auto')
  })
})

describe('consciousness parameter presets', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('applies the DeepSeek set as soon as that model is selected', async () => {
    const store = useConsciousnessStore()
    const settings = useConsciousnessSettingsStore()

    store.activeProvider = 'deepseek'
    store.activeModel = 'deepseek-chat'
    await nextTick()

    // 预设写的就是请求读的那一份：滑杆值与开关，没有第二份「生效值」。
    expect(store.temperature).toBe(0.8)
    expect(store.topP).toBe(0.9)
    expect(settings.temperatureEnabled).toBe(true)
    expect(store.activeTemperature).toBe(0.8)
    expect(store.activeParamPreset?.id).toBe('deepseek')
  })

  it('keeps one set per family, so switching the model switches the values back', async () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'deepseek'
    store.activeModel = 'deepseek-chat'
    await nextTick()
    store.temperature = 0.1
    store.saveParamPresetFromCurrent('deepseek')

    store.activeProvider = 'minimax'
    store.activeModel = 'minimax-m2'
    await nextTick()
    expect(store.temperature).toBe(1)

    store.activeProvider = 'deepseek'
    store.activeModel = 'deepseek-chat'
    await nextTick()
    // 存回 DeepSeek 那套的值还在，没有被 MiniMax 的默认值覆盖。
    expect(store.temperature).toBe(0.1)
  })

  it('keeps a separate set for every model, not only for the family', async () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'deepseek'
    store.activeModel = 'deepseek-chat'
    await nextTick()
    store.temperature = 0.1
    store.saveParamPresetFromCurrent('deepseek')

    // 同族的另一个模型：先拿家族起点，不拿 deepseek-chat 的值。
    store.activeModel = 'deepseek-reasoner'
    await nextTick()
    expect(store.temperature).toBe(0.8)
    expect(store.activeParamPresetScope).toBe('default')

    store.temperature = 0.85
    store.saveParamPresetFromCurrent('deepseek')

    // 切回去：每个模型自己的值都还在。
    store.activeModel = 'deepseek-chat'
    await nextTick()
    expect(store.temperature).toBe(0.1)
    expect(store.activeParamPresetScope).toBe('model')

    store.activeModel = 'deepseek-reasoner'
    await nextTick()
    expect(store.temperature).toBe(0.85)
  })

  it('migrates the old flat set instead of silently resetting to the family default', async () => {
    localStorage.clear()
    localStorage.setItem('settings/consciousness/param-presets', JSON.stringify({
      deepseek: { temperature: 0.15, topP: 0.8, temperatureEnabled: true, topPEnabled: false },
    }))

    const store = useConsciousnessStore()
    store.activeProvider = 'deepseek'
    store.activeModel = 'deepseek-chat'
    await nextTick()

    expect(store.temperature).toBe(0.15)
    expect(store.topP).toBe(0.8)
    // 旧键迁完就删：留着两份真源，下一次只会更难判断哪份在生效。
    expect(localStorage.getItem('settings/consciousness/param-presets')).toBeNull()
    expect(localStorage.getItem('settings/consciousness/param-presets-by-model')).toContain('0.15')
  })

  it('remembers a switch the user turned off for that model', async () => {
    const store = useConsciousnessStore()
    const settings = useConsciousnessSettingsStore()

    store.activeProvider = 'deepseek'
    store.activeModel = 'deepseek-chat'
    await nextTick()
    expect(settings.temperatureEnabled).toBe(true)

    await settings.setTemperatureEnabled(false)
    await nextTick()

    // 重新套用一次（等价于下次启动时的 immediate watcher）。
    store.applyParamPreset('deepseek')
    await nextTick()
    expect(settings.temperatureEnabled).toBe(false)
    expect(store.activeTemperature).toBeUndefined()
  })

  it('matches a model id that runs under another provider', async () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'volcengine-coding-plan'
    store.activeModel = 'volcengine-coding-plan/deepseek-v4-flash'
    await nextTick()

    expect(store.activeParamPreset?.id).toBe('deepseek')
    expect(store.temperature).toBe(0.8)
  })

  it('changes nothing when no preset matches', async () => {
    const store = useConsciousnessStore()

    store.temperature = 0.55
    store.activeProvider = 'openai'
    store.activeModel = 'gpt-4o-mini'
    await nextTick()

    expect(store.activeParamPreset).toBeUndefined()
    expect(store.temperature).toBe(0.55)
  })
})
