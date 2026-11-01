import { describe, expect, it } from 'vitest'

import { parseActivityAssessment } from './activity'

describe('parseActivityAssessment', () => {
  it('reads the plain object', () => {
    const out = parseActivityAssessment('{"activity":"写代码，改记忆模块","interruptible":false,"reason":"正在专注","confidence":0.8}')
    expect(out).toEqual({ activity: '写代码，改记忆模块', interruptible: false, reason: '正在专注', confidence: 0.8 })
  })

  it('reads through a code fence and surrounding prose', () => {
    const raw = 'Sure!\n```json\n{"activity":"看视频","interruptible":true,"reason":"只是浏览"}\n```\n hope that helps'
    expect(parseActivityAssessment(raw)).toMatchObject({ activity: '看视频', interruptible: true })
  })

  it('accepts the aliases a model may use', () => {
    expect(parseActivityAssessment('{"what":"开会","canInterrupt":"false","why":"会议中"}')).toMatchObject({
      activity: '开会',
      interruptible: false,
      reason: '会议中',
    })
  })

  it('is undefined when the answer is not JSON', () => {
    expect(parseActivityAssessment('The user seems to be writing code.')).toBeUndefined()
  })

  it('is undefined when the flag is missing, so the caller falls back instead of assuming idle', () => {
    expect(parseActivityAssessment('{"activity":"写代码"}')).toBeUndefined()
  })

  it('clamps confidence and truncates long fields', () => {
    const out = parseActivityAssessment(`{"activity":"${'长'.repeat(80)}","interruptible":true,"confidence":7}`)
    expect(out?.activity.length).toBe(40)
    expect(out?.confidence).toBe(1)
  })
})
