import { describe, expect, it } from 'vitest'

import { blindSense, digestSense } from './sense'

const seen = (text: string, at = 0, kind: 'screen' | 'camera' = 'screen') => ({ kind, text, at })

describe('a companion with no eyes', () => {
  it('reports nothing and never fails', async () => {
    await expect(blindSense.look()).resolves.toEqual([])
  })
})

describe('digestSense', () => {
  it('treats everything as new when nothing was seen before', () => {
    const digest = digestSense([seen('a build log'), seen('a browser window')], [])
    expect(digest.texts).toEqual(['a build log', 'a browser window'])
    expect(digest.novel).toBe(true)
    expect(digest.fresh).toHaveLength(2)
  })

  it('does not count the same screen twice', () => {
    const digest = digestSense([seen('the same editor')], ['the same editor'])
    expect(digest.texts).toEqual([])
    expect(digest.novel).toBe(false)
  })

  it('reports only the new lines of a mixed view', () => {
    const digest = digestSense(
      [seen('the same editor'), seen('a new error dialog')],
      ['the same editor'],
    )
    expect(digest.texts).toEqual(['a new error dialog'])
    expect(digest.novel).toBe(true)
  })

  it('ignores blank observations', () => {
    const digest = digestSense([seen(''), seen('   ')], [])
    expect(digest.novel).toBe(false)
  })

  it('keeps the camera and the screen apart by text, not by kind', () => {
    const digest = digestSense([seen('a face', 0, 'camera')], ['a face'])
    expect(digest.novel).toBe(false)
  })
})
