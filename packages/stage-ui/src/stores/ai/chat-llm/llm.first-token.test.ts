import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A provider that accepts the request and then stays silent is the pseudo-connection this test guards:
 * the socket is open, no event arrives, and without the watchdog the turn never settles.
 */
const streamFrom = vi.fn()

vi.mock('@proj-airi/core-agent', () => ({
  streamFrom: (...args: unknown[]) => streamFrom(...args),
  isContentArrayRelatedError: () => false,
  isToolRelatedError: () => false,
  modelKey: () => 'test-model',
}))

vi.mock('@xsai/model', () => ({ listModels: vi.fn(async () => []) }))

const { useLLM } = await import('./llm')

const provider = {
  generation: () => ({}),
} as never

beforeEach(() => {
  setActivePinia(createPinia())
  streamFrom.mockReset()
})

describe('llm stream silence watchdog', () => {
  it('aborts a request that never emits so the turn settles instead of spinning', async () => {
    streamFrom.mockImplementation(({ options }: { options: { abortSignal: AbortSignal } }) => new Promise((_, reject) => {
      options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true })
    }))

    const llm = useLLM()
    await expect(llm.stream('test-model', provider, [] as never, { firstTokenTimeoutMs: 25 }))
      .rejects
      .toThrow(/no output/)
  })

  it('stops the watchdog once the first event arrives', async () => {
    streamFrom.mockImplementation(async ({ options }: { options: { onStreamEvent: (event: unknown) => Promise<void> } }) => {
      await options.onStreamEvent({ type: 'text-delta', text: 'hi' })
      // Longer than the silence budget: a stream that already produced output must not be aborted.
      await new Promise(resolve => setTimeout(resolve, 70))
    })

    const llm = useLLM()
    await expect(llm.stream('test-model', provider, [] as never, { firstTokenTimeoutMs: 25 }))
      .resolves
      .toBeUndefined()
  })

  it('leaves the caller’s abort signal in charge', async () => {
    const caller = new AbortController()
    streamFrom.mockImplementation(({ options }: { options: { abortSignal: AbortSignal } }) => new Promise((_, reject) => {
      options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true })
      setTimeout(() => caller.abort(new Error('caller stopped')), 10)
    }))

    const llm = useLLM()
    await expect(llm.stream('test-model', provider, [] as never, { abortSignal: caller.signal, firstTokenTimeoutMs: 5_000 }))
      .rejects
      .toThrow(/caller stopped/)
  })
})
