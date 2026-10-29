import { describe, expect, it } from 'vitest'

import { inferRequestTraits } from './request-traits'

describe('inferRequestTraits', () => {
  it('treats a short question as light work', () => {
    const traits = inferRequestTraits('what time is it in Tokyo?')
    expect(traits.tedium).toBeLessThan(0.2)
    expect(traits.mess).toBeLessThan(0.2)
    expect(traits.durationMin).toBeLessThanOrEqual(1)
  })

  it('treats an explicit chore word as dull work', () => {
    expect(inferRequestTraits('please reformat this list').tedium).toBeGreaterThan(0.5)
    expect(inferRequestTraits('帮我整理一下这些笔记').tedium).toBeGreaterThan(0.5)
  })

  it('treats indented blocks as mess', () => {
    const pasted = ['function a() {', '\treturn 1', '}', 'function b() {', '\treturn 2', '}'].join('\n')
    expect(inferRequestTraits(pasted).mess).toBeGreaterThan(0.3)
  })

  it('treats very long lines as mess', () => {
    const long = `${'x'.repeat(300)}\n${'y'.repeat(300)}`
    expect(inferRequestTraits(long).mess).toBeGreaterThan(0.5)
  })

  it('caps the estimated duration', () => {
    expect(inferRequestTraits('x'.repeat(50_000)).durationMin).toBeLessThanOrEqual(30)
  })

  it('keeps every value inside its range', () => {
    const traits = inferRequestTraits('')
    expect(traits.mess).toBeGreaterThanOrEqual(0)
    expect(traits.tedium).toBeLessThanOrEqual(1)
    expect(traits.durationMin).toBeGreaterThanOrEqual(0)
  })
})
