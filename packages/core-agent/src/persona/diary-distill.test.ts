import type { Thought } from './inner-stream'

import { describe, expect, it } from 'vitest'

import { distillDay } from './diary-distill'

const at = (hour: number, minute = 0) => new Date(`2026-10-25T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime()
function thought(hour: number, text: string, visibility: 'private' | 'shared' = 'private'): Thought {
  return {
    id: `t-${hour}-${text}`,
    at: at(hour),
    text,
    visibility,
  }
}

describe('distillDay', () => {
  it('returns nothing for an empty day', () => {
    expect(distillDay([], { date: '2026-10-25' })).toBeUndefined()
  })

  it('names the entry after the day', () => {
    const entry = distillDay([thought(9, 'noticed: a failing build')], { date: '2026-10-25' })
    expect(entry?.name).toBe('diary-2026-10-25')
    expect(entry?.description).toBe('a failing build')
    expect(entry?.body).toContain('- 09:00 a failing build')
  })

  it('keeps at most three lines', () => {
    const thoughts = Array.from({ length: 20 }, (_, i) => thought(8 + Math.floor(i / 4), `noticed: item ${i}`))
    const entry = distillDay(thoughts, { date: '2026-10-25' })
    expect(entry?.body.split('\n')).toHaveLength(3)
  })

  it('prefers a thought she said out loud', () => {
    const thoughts = [
      thought(9, 'noticed: private one'),
      thought(10, 'noticed: said one', 'shared'),
      thought(11, 'noticed: private two'),
    ]
    const entry = distillDay(thoughts, { date: '2026-10-25' })
    expect(entry?.body).toContain('said one')
  })

  it('spreads the rest across the day', () => {
    const thoughts = [
      thought(8, 'noticed: morning'),
      thought(12, 'noticed: noon'),
      thought(18, 'noticed: evening'),
    ]
    const entry = distillDay(thoughts, { date: '2026-10-25', max: 3 })
    expect(entry?.body).toContain('morning')
    expect(entry?.body).toContain('evening')
  })

  it('never repeats a line to fill the slots', () => {
    const one = distillDay([thought(9, 'noticed: only line')], { date: '2026-10-25' })
    expect(one?.body.split('\n')).toHaveLength(1)

    const two = distillDay([thought(9, 'noticed: a'), thought(18, 'noticed: b')], { date: '2026-10-25' })
    expect(two?.body.split('\n')).toHaveLength(2)
    expect(new Set(two?.body.split('\n')).size).toBe(2)
  })

  it('truncates a long description', () => {
    const entry = distillDay([thought(9, `noticed: ${'x'.repeat(200)}`)], { date: '2026-10-25' })
    expect(entry?.description.length).toBe(80)
    expect(entry?.description.endsWith('…')).toBe(true)
  })

  it('ignores blank thoughts', () => {
    expect(distillDay([thought(9, '   ')], { date: '2026-10-25' })).toBeUndefined()
  })
})
