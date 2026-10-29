import { describe, expect, it, vi } from 'vitest'

import { safeClone } from './safe-clone'

describe('safeClone', () => {
  it('clones plain data exactly like structuredClone', () => {
    const source = { text: '记忆', nested: { count: 2 }, list: [1, 2, 3] }
    const cloned = safeClone(source, 'test')
    expect(cloned).toEqual(source)
    expect(cloned).not.toBe(source)
  })

  it('survives a field that structuredClone rejects', () => {
    // 真实事故: 信封里混进宿主对象 → DataCloneError → 整轮发送失败, UI 只显示
    // "Failed to execute 'structuredClone' on 'Window': # could not be cloned."
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = {
      text: 'keep me',
      metadata: { source: { id: 'recalled' } },
      handler: () => {},
      element: { nodeType: 1, tagName: 'DIV', childNodes: [] },
    }

    const cloned = safeClone(source, 'envelope')

    expect(cloned.text).toBe('keep me')
    expect(cloned.metadata).toEqual({ source: { id: 'recalled' } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('safeClone(envelope) dropped')
    warn.mockRestore()
  })

  it('keeps the usable rest of an array whose element is unclonable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cloned = safeClone({ parts: ['a', { nodeType: 9, childNodes: [] }, 'c'] }, 'array')
    expect(cloned.parts[0]).toBe('a')
    expect(cloned.parts[2]).toBe('c')
    warn.mockRestore()
  })

  it('does not hang on a circular structure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source: Record<string, unknown> = { text: 'loop' }
    source.self = source
    // structuredClone 自己能处理环,所以这里走的是直通分支,不应告警也不应抛错
    const cloned = safeClone(source, 'circular')
    expect(cloned.text).toBe('loop')
    warn.mockRestore()
  })
})
