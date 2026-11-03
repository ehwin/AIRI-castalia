import type { ChatHistoryItem } from '@proj-airi/core-agent'

import { describe, expect, it } from 'vitest'

import { lastOwnerMessageAt, scopedTopic, toAutonomyInput } from './adapter'

function ownerMessage(createdAt: number): ChatHistoryItem {
  return { role: 'user', content: 'hello', id: `u-${createdAt}`, createdAt }
}

function noticeMessage(createdAt: number): ChatHistoryItem {
  return { role: 'user', content: 'a task finished', id: `n-${createdAt}`, createdAt, notice: { source: 'recipe:Research' } }
}

function assistantMessage(createdAt: number): ChatHistoryItem {
  return { role: 'assistant', content: 'hi there', id: `a-${createdAt}`, createdAt, slices: [], tool_results: [] }
}

describe('last owner message', () => {
  it('returns null without messages', () => {
    expect(lastOwnerMessageAt(undefined)).toBeNull()
    expect(lastOwnerMessageAt([])).toBeNull()
  })

  it('reads the newest owner message', () => {
    expect(lastOwnerMessageAt([ownerMessage(100), assistantMessage(200), ownerMessage(300)])).toBe(300)
  })

  it('ignores a notice, because the owner did not write it', () => {
    expect(lastOwnerMessageAt([ownerMessage(100), noticeMessage(500)])).toBe(100)
    expect(lastOwnerMessageAt([noticeMessage(500)])).toBeNull()
  })

  it('ignores a message with no usable time', () => {
    const withoutTime: ChatHistoryItem = { role: 'user', content: 'hi', id: 'u-none' }
    expect(lastOwnerMessageAt([ownerMessage(100), withoutTime])).toBe(100)
  })
})

describe('autonomy input', () => {
  it('fills the missing drives with neutral values', () => {
    const input = toAutonomyInput({
      now: 1000,
      lastSpokeAt: null,
      messages: undefined,
      snapshot: { energy: 70, currentDesire: null, arousal: undefined },
      relationshipStage: undefined,
    })

    expect(input).toEqual({
      now: 1000,
      lastSpokeAt: null,
      lastUserAt: null,
      energy: 70,
      desire: '',
      arousal: 0,
      relationshipDepth: 1,
    })
  })

  it('carries the recorded drives', () => {
    const input = toAutonomyInput({
      now: 5000,
      lastSpokeAt: 4000,
      messages: [ownerMessage(3000)],
      snapshot: { energy: 42, currentDesire: 'finish the song', arousal: -0.8 },
      relationshipStage: 3,
    })

    expect(input.lastSpokeAt).toBe(4000)
    expect(input.lastUserAt).toBe(3000)
    expect(input.energy).toBe(42)
    expect(input.desire).toBe('finish the song')
    expect(input.arousal).toBe(-0.8)
    expect(input.relationshipDepth).toBe(3)
  })

  // ROOT CAUSE: every character without a desire shared the single topic key `idle`, so one character's idle line
  // muted the dedupe for four hours for all the others. The key carries the persona now.
  describe('scopedTopic', () => {
    it('keeps two characters apart on the same desire', () => {
      expect(scopedTopic('airi', 'idle')).not.toBe(scopedTopic('yuno', 'idle'))
    })

    it('normalizes the desire and falls back to idle', () => {
      expect(scopedTopic('airi', '  Finish  the SONG ')).toBe('airi:finishthesong')
      expect(scopedTopic('airi', null)).toBe('airi:idle')
      expect(scopedTopic('airi', '   ')).toBe('airi:idle')
    })
  })
})
