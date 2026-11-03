import { describe, expect, it } from 'vitest'

import { createRelationalPolicyContextProvider } from './relational-policy'

/**
 * The provider is the only place that can count farewell turns, so these tests
 * pin down what a session actually gets: a closing instruction on the turn where
 * the user leaves, and the normal policy on every other turn.
 *
 * What they cannot see: `pre-closing` and `closed` render the same text, so the
 * run counter is covered by `nextClosingRun()` / `closingFromRun()` in
 * `@proj-airi/core-agent` instead.
 */
describe('createRelationalPolicyContext', () => {
  it('tells her the user is leaving when the turn is a goodbye', () => {
    const provider = createRelationalPolicyContextProvider()

    const message = provider('session-1', { id: 'm1', text: '我去洗澡了，先不聊啦' }, 'persona-1')

    expect(message?.contextId).toBe('relational-policy')
    expect(message?.text).toContain('ending the conversation')
    expect(message?.text).toContain('Never use your own feelings')
  })

  it('keeps the normal policy on a turn that is not a goodbye', () => {
    const provider = createRelationalPolicyContextProvider()

    const message = provider('session-1', { id: 'm1', text: '今天数学课讲函数渐近线，头都大了' }, 'persona-1')

    expect(message?.text).toContain('guidance for you')
    expect(message?.text).not.toContain('ending the conversation')
  })

  it('does not treat a question that mentions leaving as a goodbye', () => {
    const provider = createRelationalPolicyContextProvider()

    const message = provider('session-1', { id: 'm1', text: '我去做饭了，你想吃什么？' }, 'persona-1')

    expect(message?.text).not.toContain('ending the conversation')
  })

  it('reuses the text of a replayed turn instead of counting it twice', () => {
    const provider = createRelationalPolicyContextProvider()

    const first = provider('session-1', { id: 'm1', text: '我困了，要睡了' }, 'persona-1')
    const replayed = provider('session-1', { id: 'm1', text: '我困了，要睡了' }, 'persona-1')

    expect(replayed?.text).toBe(first?.text)
  })

  it('keeps two personas apart even inside one session', () => {
    const provider = createRelationalPolicyContextProvider()

    const yuno = provider('session-1', { id: 'm1', text: '我先去忙了' }, 'persona-1')
    const other = provider('session-1', { id: 'm2', text: '今天天气不错' }, 'persona-2')

    expect(yuno?.text).toContain('ending the conversation')
    expect(other?.text).not.toContain('ending the conversation')
  })

  it('adds nothing when there is no user turn to read', () => {
    const provider = createRelationalPolicyContextProvider()

    expect(provider('session-1', undefined, 'persona-1')).toBeUndefined()
    expect(provider('session-1', { id: 'm1', text: '   ' }, 'persona-1')).toBeUndefined()
  })
})
