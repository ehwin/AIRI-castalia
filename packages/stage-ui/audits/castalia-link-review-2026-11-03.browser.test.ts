import type { MemoryRecall } from '../src/stores/memory'

import en from '@proj-airi/i18n/locales/en'

import { createPinia, disposePinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'

import { useLLM } from '../src/stores/ai/chat-llm/llm'
import { useChatStore } from '../src/stores/chat'
import { useChatSessionStore } from '../src/stores/chat/session-store'
import { useMemoryStore } from '../src/stores/memory'
import { useModsServerChannelStore } from '../src/stores/mods/api/channel-server'
import { useConsciousnessStore } from '../src/stores/modules/consciousness'

const pinias: ReturnType<typeof createPinia>[] = []

async function setupChat(recall: (query: string, persona?: string) => Promise<MemoryRecall>) {
  const modules = {
    consciousness: { provider: 'openai', model: 'audit-model' },
    vision: { provider: '', model: '' },
    speech: { provider: '', model: '', voice_id: '' },
  }
  localStorage.setItem('airi-cards', JSON.stringify(['default', 'second-card'].map(id => [id, {
    name: id,
    version: '1.0',
    extensions: { airi: { agents: {}, modules } },
  }])))
  localStorage.setItem('airi-card-module-defaults', JSON.stringify(modules))
  const pinia = createPinia()
  pinias.push(pinia)
  render(defineComponent({
    setup() {
      useChatStore()
      return () => h('div')
    },
  }), { global: { plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
  const sessions = useChatSessionStore(pinia)
  await sessions.initialize()
  await sessions.createSession('default')
  const consciousness = useConsciousnessStore(pinia)
  consciousness.activeProvider = 'openai'
  consciousness.activeModel = 'audit-model'
  vi.spyOn(consciousness, 'getChatProviderInstance').mockResolvedValue({
    generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.com/' } }),
  })
  const prompts: string[] = []
  vi.spyOn(useLLM(pinia), 'stream').mockImplementation(async (_model, _provider, context, options) => {
    prompts.push(JSON.stringify(context))
    await options?.onStreamEvent?.({ type: 'text-delta', text: 'audit reply' })
    await options?.onStreamEvent?.({ type: 'finish' })
  })
  const memory = useMemoryStore(pinia)
  memory.enabled = true
  memory.attachRemote({ list: async () => [], save: async () => {}, forget: async () => true, recall })
  return { chat: useChatStore(pinia), sessions, memory, prompts }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const pinia of pinias.splice(0)) {
    useModsServerChannelStore(pinia).dispose()
    useChatStore(pinia).dispose()
    disposePinia(pinia)
  }
  localStorage.clear()
})

// A02 (fixed): the recall now follows the session that is sending, not the tab that is visible.
it('uses the sending session query and character during a background send', async () => {
  const recall = vi.fn(async () => ({ text: '', count: 0, topSim: 0, chars: 0 }))
  const { chat, sessions, prompts } = await setupChat(recall)
  const selected = sessions.activeSessionId
  await chat.send({ sessionId: selected, text: 'SELECTED_QUERY' })
  const sending = await sessions.createSession('second-card', { setActive: false })
  recall.mockClear()

  await chat.send({ sessionId: sending, text: 'ACTUAL_SENDING_QUERY' })

  expect(sessions.activeSessionId).toBe(selected)
  expect(recall).toHaveBeenCalledWith('ACTUAL_SENDING_QUERY', 'second-card')
  expect(recall).not.toHaveBeenCalledWith('SELECTED_QUERY', 'default')
  expect(prompts.at(-1)).toContain('ACTUAL_SENDING_QUERY')
})

// A03 (fixed): a turn that recalls nothing clears the previous block instead of leaving it in the
// request, and a block never crosses into another session.
it.each(['miss', 'reject', 'timeout', 'disabled', 'new-session'] as const)(
  'drops the previous recall from the next model prompt after %s',
  async (mode) => {
    const marker = 'PRIVATE_RECALL_MARKER'
    const hit: MemoryRecall = { text: marker, count: 1, topSim: 1, chars: marker.length }
    const miss: MemoryRecall = { text: '', count: 0, topSim: 0, chars: 0 }
    // A send reads its contexts more than once (every provider uses ReplaceSelf, so a second pass is
    // idempotent). The stub therefore answers by turn, not by call count.
    let turn = 0
    const recall = vi.fn<(query: string, persona?: string) => Promise<MemoryRecall>>(async () => {
      if (turn === 0)
        return hit
      if (mode === 'timeout')
        return await new Promise<MemoryRecall>(() => {})
      if (mode === 'reject')
        throw new Error('audit: recall offline')
      return miss
    })
    const { chat, sessions, memory, prompts } = await setupChat(recall)
    await chat.send({ sessionId: sessions.activeSessionId, text: 'first query' })
    expect(prompts.at(-1)).toContain(marker)
    turn = 1
    if (mode === 'disabled')
      memory.enabled = false
    if (mode === 'new-session')
      await sessions.createSession('second-card')

    await chat.send({ sessionId: sessions.activeSessionId, text: 'unrelated next query' })

    expect(prompts).toHaveLength(2)
    expect(prompts.at(-1)).not.toContain(marker)
    if (mode === 'disabled')
      expect(recall).toHaveBeenCalledOnce()
    if (mode === 'new-session')
      expect(recall).toHaveBeenLastCalledWith('unrelated next query', 'second-card')
  },
)
