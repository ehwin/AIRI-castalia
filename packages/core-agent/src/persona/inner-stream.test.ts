import { describe, expect, it } from 'vitest'

import { createStream, markShared, record, sharedRatio } from './inner-stream'

function thought(id: string, visibility: 'private' | 'shared' = 'private') {
  return { id, at: 1, text: `noticed: ${id}`, visibility, topic: 'self-cycle' } as const
}

describe('markShared', () => {
  it('moves one thought out of the private stream', () => {
    let stream = createStream()
    stream = record(stream, thought('a'))
    stream = record(stream, thought('b'))

    stream = markShared(stream, 'a')

    expect(stream.entries.find(entry => entry.id === 'a')?.visibility).toBe('shared')
    expect(stream.entries.find(entry => entry.id === 'b')?.visibility).toBe('private')
    expect(sharedRatio(stream)).toBe(0.5)
  })

  it('leaves the stream alone for an unknown or already shared id', () => {
    let stream = createStream()
    stream = record(stream, thought('a', 'shared'))

    expect(markShared(stream, 'missing')).toBe(stream)
    expect(markShared(stream, 'a')).toBe(stream)
  })
})
