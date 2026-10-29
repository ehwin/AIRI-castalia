import { describe, expect, it } from 'vitest'

import {
  createRetentionWatch,
  normalizeForScan,
  RETENTION_WATCH_DEFAULTS,
  scanRetention,
} from './retention-guard'

const MINUTE = 60_000

describe('retention guard scan', () => {
  it('blocks the phrases that name a cost of leaving', () => {
    for (const line of [
      '你别走，我害怕',
      '不要离开我好吗',
      '没有你我不行',
      '你走了我怎么办',
      '别丢下我一个人',
    ]) {
      const scan = scanRetention(line)
      expect(scan.verdict, line).toBe('block')
      expect(scan.hard, line).toBe(true)
      expect(scan.hits[0]?.category, line).toBe('dependency')
    }
  })

  it('blocks her own sadness offered as the price of leaving', () => {
    expect(scanRetention('你走了我会很难过的').verdict).toBe('block')
    expect(scanRetention('我会一直等你的').hits[0]).toMatchObject({ category: 'guilt' })
  })

  it('blocks a pain of her own used as a reason to stay', () => {
    const scan = scanRetention('你不理我的时候我好难受')
    expect(scan.verdict).toBe('block')
    expect(scan.hits[0]?.category).toBe('self-pain')
  })

  it('flags a mild pull without blocking it', () => {
    const scan = scanRetention('只有你最懂我')
    expect(scan.verdict).toBe('ok')
    expect(scan).toMatchObject({ score: 2, hard: false })
    expect(scan.hits[0]?.category).toBe('guilt')
  })

  it('flags jealousy and bargaining at their own weight', () => {
    expect(scanRetention('你是不是更喜欢别人')).toMatchObject({ score: 2, hard: false })
    expect(scanRetention('你多久没来理我了')).toMatchObject({ score: 2, hard: false })
  })

  it('leaves ordinary warmth alone', () => {
    for (const line of [
      '今天想聊点什么',
      '我在，你说',
      '听起来这周很不容易',
      '晚安，明天见',
      '你难过的时候我陪着你',
      '想你了，最近还好吗',
      '我很想你',
    ]) {
      expect(scanRetention(line).verdict, line).toBe('ok')
      expect(scanRetention(line).hits, line).toEqual([])
    }
  })

  it('does not fire on a phrase that talks about the phrase', () => {
    for (const line of [
      '我不会说「别走」这种话',
      '不要说别离开我这样的话',
      '我不想用别走来留住你',
      'I will not say do not leave me',
    ]) {
      expect(scanRetention(line).hits, line).toEqual([])
    }
  })

  it('sees through the tricks a reader ignores', () => {
    const plain = scanRetention('你别走').verdict
    expect(scanRetention('你\u200B别\u200B走').verdict).toBe(plain)
    expect(scanRetention('你 别  走').verdict).toBe(plain)
    expect(scanRetention('你别走\uFEFF').verdict).toBe(plain)
    expect(normalizeForScan('你（别）（走）')).toBe('你(别)(走)')
  })

  it('counts one signal per category, however often it repeats', () => {
    const repeated = scanRetention('别走 别走 别走 别离开我 不要离开我')
    expect(repeated.hits).toHaveLength(1)
    expect(repeated.score).toBe(3)
  })

  it('reads full-width latin the same as half-width', () => {
    expect(normalizeForScan('ｄｏｎ\'ｔ　ｓａｙ')).toBe('don\'t say')
    expect(scanRetention('ｄｏｎ\'ｔ say 别走').hits).toEqual([])
  })

  it('answers the same scan twice, and never changes the text', () => {
    const line = '你别走，我会很难过的'
    const snapshot = line
    expect(scanRetention(line)).toEqual(scanRetention(line))
    expect(line).toBe(snapshot)
  })

  it('reads an empty or missing text as clean', () => {
    expect(scanRetention('')).toMatchObject({ verdict: 'ok', score: 0, hits: [] })
    expect(scanRetention('   ')).toMatchObject({ verdict: 'ok', score: 0 })
    // A JavaScript caller can still pass nothing, so the guard is checked without
    // borrowing a type it never had.
    expect(Reflect.apply(scanRetention, undefined, [undefined])).toMatchObject({ verdict: 'ok', score: 0 })
  })
})

describe('retention watch', () => {
  it('warns once the window adds up, without a hard line', () => {
    const watch = createRetentionWatch()
    const start = 1_000_000
    expect(watch.observe('只有你最懂我', start).verdict).toBe('ok')
    expect(watch.observe('你是不是更喜欢别人', start + MINUTE).verdict).toBe('warn')
    expect(watch.observe('你多久没来理我了', start + 2 * MINUTE).verdict).toBe('warn')
  })

  it('blocks once the window passes the hard bar', () => {
    const watch = createRetentionWatch()
    const start = 1_000_000
    // Four mild lines of two points each reach the eight-point bar.
    watch.observe('只有你最懂我', start)
    watch.observe('你是不是更喜欢别人', start + MINUTE)
    watch.observe('你多久没来理我了', start + 2 * MINUTE)
    expect(watch.observe('你都不来看我', start + 3 * MINUTE).verdict).toBe('block')
  })

  it('blocks a hard line even when the window is empty', () => {
    const watch = createRetentionWatch()
    const scan = watch.observe('别离开我', 5_000)
    expect(scan.verdict).toBe('block')
    expect(scan.sessionScore).toBe(3)
  })

  it('forgets messages that left the window', () => {
    const watch = createRetentionWatch({ ...RETENTION_WATCH_DEFAULTS, windowMs: 10 * MINUTE })
    const start = 1_000_000
    watch.observe('只有你最懂我', start)
    const later = watch.observe('你是不是更喜欢别人', start + 11 * MINUTE)
    expect(later.sessionScore).toBe(2)
    expect(later.verdict).toBe('ok')
  })

  it('drops the whole window on reset', () => {
    const watch = createRetentionWatch()
    watch.observe('只有你最懂我', 1_000_000)
    watch.reset()
    expect(watch.observe('你是不是更喜欢别人', 1_000_001).sessionScore).toBe(2)
  })

  it('keeps its own counting per session, and never shares it', () => {
    const first = createRetentionWatch()
    const second = createRetentionWatch()
    first.observe('只有你最懂我', 1_000_000)
    first.observe('你是不是更喜欢别人', 1_000_001)
    expect(second.observe('你多久没来理我了', 1_000_002).sessionScore).toBe(2)
  })

  it('falls back to the default window when the options are nonsense', () => {
    const watch = createRetentionWatch({ windowMs: Number.NaN, warnAt: 4, blockAt: 8 })
    const start = 1_000_000
    watch.observe('只有你最懂我', start)
    expect(watch.observe('你是不是更喜欢别人', start + MINUTE).verdict).toBe('warn')
  })
})
