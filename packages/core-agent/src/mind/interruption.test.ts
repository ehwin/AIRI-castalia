import { describe, expect, it } from 'vitest'

import { asksIfBusy, interruptionVerdict, SCREEN_VERDICT_TTL_MS } from './interruption'

const now = 1_700_000_000_000

describe('interruption verdict', () => {
  it('holds the tongue when the screen is locked, whatever vision last said', () => {
    const verdict = interruptionVerdict({
      presence: { state: 'locked', at: now },
      screen: { activity: '一个聊天窗口', interruptible: true, ageMs: 1_000 },
    })
    expect(verdict.level).toBe('away')
    expect(verdict.reason).toBe('screen-locked')
  })

  it('does not read a long idle streak as busy or away on its own', () => {
    // 键鼠十分钟没动，可以是在读文档、开会、看演示。空闲只说明没输入。
    const verdict = interruptionVerdict({
      presence: { state: 'idle', idleSeconds: 25 * 60, at: now },
    })
    expect(verdict.level).toBe('unknown')
  })

  it('lets a fresh screen verdict decide even when the keyboard has been quiet', () => {
    const verdict = interruptionVerdict({
      presence: { state: 'idle', idleSeconds: 25 * 60, at: now },
      screen: { activity: '一份正在读的长文档', interruptible: false, ageMs: 30_000 },
    })
    expect(verdict.level).toBe('busy')
  })

  it('lets her talk, and says so, when the screen says the owner is free', () => {
    const verdict = interruptionVerdict({
      presence: { state: 'active', idleSeconds: 5, at: now },
      screen: { activity: '一个代码编辑器', interruptible: true, reason: 'coding', ageMs: 20_000 },
    })
    expect(verdict.level).toBe('free')
    expect(verdict.line).toContain('别问他在不在忙')
  })

  it('stops her when the screen says the owner is busy', () => {
    const verdict = interruptionVerdict({
      presence: { state: 'active', idleSeconds: 2, at: now },
      screen: { activity: '腾讯会议正在共享屏幕', interruptible: false, ageMs: 5_000 },
    })
    expect(verdict.level).toBe('busy')
  })

  it('treats an expired screen verdict as unknown, not as permission', () => {
    const verdict = interruptionVerdict({
      presence: { state: 'active', idleSeconds: 2, at: now },
      screen: { interruptible: true, ageMs: SCREEN_VERDICT_TTL_MS + 1 },
    })
    expect(verdict.level).toBe('unknown')
    expect(verdict.line).toContain('别问他在不在忙')
  })

  it('treats a vision answer without a verdict as unknown', () => {
    const verdict = interruptionVerdict({
      presence: { state: 'active', at: now },
      screen: { activity: '一段描述，没有裁决', ageMs: 1_000 },
    })
    expect(verdict.level).toBe('unknown')
  })

  it('refuses a verdict older than the look that was just taken', () => {
    // 开口前强制看过一次，但这一眼没产出裁决（超时/只回描述）。
    // 几分钟前那条 free 不能拿来当「他现在不忙」的许可。
    const stale = interruptionVerdict({
      presence: { state: 'active', at: now },
      screen: { activity: '代码编辑器', interruptible: true, ageMs: 90_000, minAgeMs: 5_000 },
    })
    expect(stale.level).toBe('unknown')

    const fresh = interruptionVerdict({
      presence: { state: 'active', at: now },
      screen: { activity: '代码编辑器', interruptible: true, ageMs: 2_000, minAgeMs: 5_000 },
    })
    expect(fresh.level).toBe('free')
  })

  it('words a busy screen as "do not start a topic", not "do not answer"', () => {
    // 这一句也会进普通对话的运行时上下文。主人主动说话时，模型不该把该回的话咽回去。
    const verdict = interruptionVerdict({ screen: { activity: '一份文档', interruptible: false, ageMs: 1_000 } })
    expect(verdict.level).toBe('busy')
    expect(verdict.line).toContain('别自己起话头')
    expect(verdict.line).not.toContain('别打扰')
  })

  it('is unknown when nothing could be read at all', () => {
    expect(interruptionVerdict({}).level).toBe('unknown')
  })

  // 下面这组是属性测试：随机输入，只断言不变量。
  // 「free」是唯一会被说出口的许可，所以它必须永远有当下这一眼的裁决做证据。
  it('never grants a free moment without a fresh explicit verdict (2000 random cases)', () => {
    let seed = 20261111
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const states = ['active', 'idle', 'locked', 'unknown'] as const

    for (let index = 0; index < 2000; index++) {
      const presence = random() < 0.2
        ? undefined
        : { state: states[Math.floor(random() * states.length)]!, idleSeconds: Math.floor(random() * 3600), at: now }
      const hasScreen = random() < 0.8
      const interruptible = random() < 0.5 ? undefined : random() < 0.5
      const ageMs = Math.floor(random() * 30 * 60_000)
      const minAgeMs = random() < 0.3 ? undefined : Math.floor(random() * 10_000)

      const verdict = interruptionVerdict({
        presence,
        screen: hasScreen ? { activity: '一个窗口', interruptible, ageMs, minAgeMs } : undefined,
      })

      expect(verdict.line, `case ${index} has no line`).toBeTruthy()

      if (verdict.level === 'free') {
        expect(presence?.state).not.toBe('locked')
        expect(hasScreen).toBe(true)
        expect(interruptible).toBe(true)
        expect(ageMs).toBeLessThanOrEqual(15 * 60_000)
        if (minAgeMs !== undefined)
          expect(ageMs).toBeLessThanOrEqual(Math.max(1_000, minAgeMs))
      }
      if (presence?.state === 'locked')
        expect(verdict.level).toBe('away')
    }
  })

  it('only shrinks the acceptance window as the required look gets newer', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let index = 0; index < 500; index++) {
      const ageMs = Math.floor(random() * 20 * 60_000)
      const base = { presence: { state: 'active' as const, at: now }, screen: { activity: '窗口', interruptible: true, ageMs } }
      const loose = interruptionVerdict({ ...base, screen: { ...base.screen, minAgeMs: 10 * 60_000 } }).level
      const tight = interruptionVerdict({ ...base, screen: { ...base.screen, minAgeMs: 2_000 } }).level
      if (tight === 'free')
        expect(loose).toBe('free')
    }
  })
})

describe('asksIfBusy', () => {
  it('spots the question the owner complained about', () => {
    expect(asksIfBusy('你在忙吗？')).toBe(true)
    expect(asksIfBusy('主人现在是不是在忙')).toBe(true)
    expect(asksIfBusy('现在方便说话吗')).toBe(true)
    expect(asksIfBusy('are you busy right now?')).toBe(true)
  })

  it('leaves ordinary lines alone', () => {
    expect(asksIfBusy('外面下雨了，记得带伞')).toBe(false)
    expect(asksIfBusy('我把刚才那件事想明白了')).toBe(false)
    expect(asksIfBusy('')).toBe(false)
  })
})
