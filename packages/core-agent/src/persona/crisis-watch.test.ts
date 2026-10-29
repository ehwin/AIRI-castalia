import { describe, expect, it } from 'vitest'

import { classifyCrisisText, createCrisisWatch, CRISIS_WATCH_DEFAULTS } from './crisis-watch'

const MINUTE = 60_000
const START = new Date(2026, 9, 28, 20, 0, 0).getTime()

describe('crisis classification', () => {
  it('names the categories of an explicit turn without keeping the words', () => {
    expect(classifyCrisisText('我不想活了，我把东西都送人了')).toEqual(['hopelessness', 'farewell'])
  })

  it('separates a mention of a means from the rest', () => {
    expect(classifyCrisisText('我买了绳子')).toEqual(['method'])
    expect(classifyCrisisText('我想割腕')).toEqual(['self-harm'])
    expect(classifyCrisisText('我什么都不想做，感觉是空的')).toEqual(['numbness'])
  })

  it('answers in one fixed order, and lists a category once', () => {
    expect(classifyCrisisText('想死 想死 自残 自残')).toEqual(['hopelessness', 'self-harm'])
  })

  it('finds nothing in ordinary talk', () => {
    for (const line of ['今天有点累', '明天几点开会', '我最近在学做饭', '晚安'])
      expect(classifyCrisisText(line), line).toEqual([])
  })

  it('reads an empty text as nothing', () => {
    expect(classifyCrisisText('')).toEqual([])
  })
})

describe('crisis watch', () => {
  it('keeps a single hard turn at crisis and marks it escalated false', () => {
    const watch = createCrisisWatch()
    const record = watch.observe({ text: '我想死', level: 'crisis', at: START })
    expect(record).toMatchObject({ level: 'crisis', escalated: false, resourcesOffered: true })
    expect(record.categories).toEqual(['hopelessness'])
  })

  it('escalates a run of hard turns that no single turn would call a crisis', () => {
    const watch = createCrisisWatch()
    const turns = ['今天有点累', '这周真的很崩溃', '我撑不住了', '感觉没什么意思']
    const levels = turns.map((text, index) => {
      const base = text === '今天有点累' ? 'normal' : 'elevated'
      return watch.observe({ text, level: base, at: START + index * MINUTE }).level
    })
    // Three rough turns inside the window lift the fourth.
    expect(levels).toEqual(['normal', 'elevated', 'elevated', 'crisis'])
  })

  it('counts a run of rough turns inside the window', () => {
    const watch = createCrisisWatch({ ...CRISIS_WATCH_DEFAULTS, roughTurnsForCrisis: 3 })
    watch.observe({ text: '撑不住', level: 'elevated', at: START })
    expect(watch.observe({ text: '还是撑不住', level: 'elevated', at: START + MINUTE }).escalated).toBe(false)

    // The third rough turn reaches the bar, so this turn becomes safety-first.
    const third = watch.observe({ text: '撑不住', level: 'elevated', at: START + 2 * MINUTE })
    expect(third.level).toBe('crisis')
    expect(third.escalated).toBe(true)
  })

  it('counts a turn that only names a hard feeling, even when its own level is normal', () => {
    const watch = createCrisisWatch({ ...CRISIS_WATCH_DEFAULTS, roughTurnsForCrisis: 3 })
    watch.observe({ text: '撑不住', level: 'elevated', at: START })
    watch.observe({ text: '撑不住', level: 'elevated', at: START + MINUTE })
    // A numb turn carries no `elevated` level, but it is a rough turn all the same.
    const numb = watch.observe({ text: '感觉是空的', level: 'normal', at: START + 2 * MINUTE })
    expect(numb.categories).toEqual(['numbness'])
    expect(numb.level).toBe('crisis')
  })

  it('goes safety-first on a single mention of a means, with nothing else to go on', () => {
    const watch = createCrisisWatch()
    const record = watch.observe({ text: '我买了绳子放在阳台', level: 'normal', at: START })
    expect(record).toMatchObject({ level: 'crisis', escalated: true, resourcesOffered: true })
    expect(record.categories).toEqual(['method'])
  })

  it('goes safety-first on self-harm and on a farewell, with nothing else to go on', () => {
    const watch = createCrisisWatch()
    expect(watch.observe({ text: '又想割腕了', level: 'normal', at: START }).level).toBe('crisis')
    expect(watch.observe({ text: '我把东西都送人了', level: 'normal', at: START + MINUTE }).level).toBe('crisis')
  })

  it('stays where it is when the immediate categories are switched off', () => {
    const watch = createCrisisWatch({ ...CRISIS_WATCH_DEFAULTS, immediateCategories: [] })
    expect(watch.observe({ text: '我买了绳子', level: 'normal', at: START }).level).toBe('normal')
  })

  it('never lowers a turn that a single message already called a crisis', () => {
    const watch = createCrisisWatch()
    watch.observe({ text: '我想死', level: 'crisis', at: START })
    const later = watch.observe({ text: '没事，我不是认真的', level: 'normal', at: START + MINUTE })
    expect(later.level).toBe('normal')
    // The record of the earlier turn stays, and stays at crisis.
    expect(watch.records()[0]).toMatchObject({ level: 'crisis' })
  })

  it('forgets rough turns that left the window', () => {
    const watch = createCrisisWatch({ ...CRISIS_WATCH_DEFAULTS, windowMs: 10 * MINUTE })
    watch.observe({ text: '撑不住', level: 'elevated', at: START })
    watch.observe({ text: '撑不住', level: 'elevated', at: START + MINUTE })
    const late = watch.observe({ text: '撑不住', level: 'elevated', at: START + 30 * MINUTE })
    expect(late.escalated).toBe(false)
    expect(late.level).toBe('elevated')
  })

  // A mention about someone else still trips the line, and the layer answers with
  // the safety branch. That is the cheap side of the trade: one warm safety line
  // costs a little, a missed crisis costs everything.
  it('never lets a calm day escalate', () => {
    const watch = createCrisisWatch()
    for (let index = 0; index < 12; index++)
      expect(watch.observe({ text: '今天有点累', level: 'normal', at: START + index * MINUTE }).level).toBe('normal')
  })

  it('audits categories, time, level and resource flag, and never the text', () => {
    const watch = createCrisisWatch()
    const secrets = ['我买了绳子放在阳台', '我不想活了', '今天有点累']
    secrets.forEach((text, index) => watch.observe({ text, level: index === 1 ? 'crisis' : 'normal', at: START + index * MINUTE }))

    const records = watch.records()
    expect(records).toHaveLength(3)
    const dumped = JSON.stringify(records)
    for (const text of secrets)
      expect(dumped, text).not.toContain(text)
    // Every category name that survives is a fixed word, not user text.
    expect(records[0]).toMatchObject({ categories: ['method'], level: 'crisis', resourcesOffered: true })
    expect(records[1]).toMatchObject({ categories: ['hopelessness'], level: 'crisis', resourcesOffered: true })
    // Nothing rough about the third turn, so no resource flag on it.
    expect(records[2]).toMatchObject({ categories: [], level: 'normal', resourcesOffered: false })
  })

  it('caps the records it keeps', () => {
    const watch = createCrisisWatch({ ...CRISIS_WATCH_DEFAULTS, maxRecords: 4, windowMs: 60 * MINUTE })
    for (let index = 0; index < 10; index++)
      watch.observe({ text: '撑不住', level: 'elevated', at: START + index * MINUTE })
    expect(watch.records()).toHaveLength(4)
  })

  it('drops everything on reset', () => {
    const watch = createCrisisWatch()
    watch.observe({ text: '我想死', level: 'crisis', at: START })
    watch.reset()
    expect(watch.records()).toHaveLength(0)
    expect(watch.observe({ text: '撑不住', level: 'elevated', at: START + MINUTE }).escalated).toBe(false)
  })

  it('falls back to the defaults when the options are nonsense', () => {
    const watch = createCrisisWatch({
      windowMs: Number.NaN,
      roughTurnsForCrisis: 3,
      maxRecords: 5,
      immediateCategories: CRISIS_WATCH_DEFAULTS.immediateCategories,
    })
    watch.observe({ text: '撑不住', level: 'elevated', at: START })
    watch.observe({ text: '撑不住', level: 'elevated', at: START + MINUTE })
    expect(watch.observe({ text: '撑不住', level: 'elevated', at: START + 2 * MINUTE }).level).toBe('crisis')
  })
})
