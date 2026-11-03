import type { ContextMessage } from '../../../types/chat'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createMemoryRecallContext, RECALL_TIMEOUT_MS } from './memory-recall'

afterEach(() => {
  vi.useRealTimers()
})

describe('createMemoryRecallContext', () => {
  it('adds the recalled block as a context message that replaces its own last block', async () => {
    const recall = vi.fn(async () => '<memory>她讨厌被叫小助手</memory>')
    const provider = createMemoryRecallContext(recall)

    const message = await provider({ text: '我们今天聊什么', sessionId: 's1' })

    expect(recall).toHaveBeenCalledWith('我们今天聊什么', 's1')
    expect(message).toMatchObject({ contextId: 'recalled:s1', text: '<memory>她讨厌被叫小助手</memory>' })
    expect((message as ContextMessage).strategy).toBe('replace-self')
  })

  // A3 fix: the block is per conversation, and an empty block replaces the last one instead of
  // leaving it in the request (audit A03). These four cases used to return undefined.
  it('clears the previous block when the backend finds no memory above its gate', async () => {
    const provider = createMemoryRecallContext(async () => '')

    expect(await provider({ text: '随便一句', sessionId: 's1' })).toMatchObject({ contextId: 'recalled:s1', text: '' })
  })

  it('clears the block for a turn with no text, so an attachment-only turn recalls nothing', async () => {
    const recall = vi.fn(async () => '<memory>never asked</memory>')
    const provider = createMemoryRecallContext(recall)

    expect(await provider({ text: '   ', sessionId: 's1' })).toMatchObject({ text: '' })
    expect(recall).not.toHaveBeenCalled()
  })

  it('clears the block when the recall fails, so a dead backend cannot keep old text alive', async () => {
    const provider = createMemoryRecallContext(async () => {
      throw new Error('engine is down')
    })

    expect(await provider({ text: '你好', sessionId: 's1' })).toMatchObject({ text: '' })
  })

  it('drops a recall that is slower than the deadline instead of holding the turn', async () => {
    vi.useFakeTimers()
    const recall = vi.fn(() => new Promise<string>((resolve) => {
      setTimeout(resolve, 5_000, '<memory>too late</memory>')
    }))
    const provider = createMemoryRecallContext(recall)

    const pending = provider({ text: '你好' })
    // The deadline is 800ms; advancing a fixed 400 used to pass only while it was 300,
    // so this test ended up waiting on the never-resolving recall instead of the timeout.
    await vi.advanceTimersByTimeAsync(RECALL_TIMEOUT_MS + 100)

    expect(await pending).toMatchObject({ text: '' })
  })

  it('keeps a recall that answers before the deadline', async () => {
    vi.useFakeTimers()
    const recall = vi.fn(() => new Promise<string>((resolve) => {
      setTimeout(resolve, 50, '<memory>just in time</memory>')
    }))
    const provider = createMemoryRecallContext(recall)

    const pending = provider({ text: '你好' })
    await vi.advanceTimersByTimeAsync(60)

    expect(await pending).toMatchObject({ text: '<memory>just in time</memory>' })
  })
})
