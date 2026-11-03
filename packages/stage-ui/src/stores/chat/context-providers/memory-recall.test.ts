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

    const message = await provider({ text: '我们今天聊什么' })

    expect(recall).toHaveBeenCalledWith('我们今天聊什么')
    expect(message).toMatchObject({ contextId: 'recalled', text: '<memory>她讨厌被叫小助手</memory>' })
    expect((message as ContextMessage).strategy).toBe('replace-self')
  })

  it('adds nothing when the backend finds no memory above its gate', async () => {
    const provider = createMemoryRecallContext(async () => '')

    expect(await provider({ text: '随便一句' })).toBeUndefined()
  })

  it('adds nothing for a turn with no text, so an attachment-only turn recalls nothing', async () => {
    const recall = vi.fn(async () => '<memory>never asked</memory>')
    const provider = createMemoryRecallContext(recall)

    expect(await provider({ text: '   ' })).toBeUndefined()
    expect(recall).not.toHaveBeenCalled()
  })

  it('adds nothing when the recall fails', async () => {
    const provider = createMemoryRecallContext(async () => {
      throw new Error('engine is down')
    })

    expect(await provider({ text: '你好' })).toBeUndefined()
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

    expect(await pending).toBeUndefined()
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
