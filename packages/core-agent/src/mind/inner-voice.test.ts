import { describe, expect, it } from 'vitest'

import { composeInnerVoice, diaryTitle, screenBusy, stripDiaryHeader } from './inner-voice'

const idle = { fatigue: 10, boredom: 5, curiosity: 5, focus: 0 }
const bored = { fatigue: 10, boredom: 70, curiosity: 10, focus: 0 }

const DIARY = `# 情感记忆: [自循环日记]

[自循环日记]
# 2026-11-01 · 疲惫到不想做任何事
用户说自己累到极点、什么都不想干，助手没提议她先躺一会儿。
摘录（用户）：「今天累死了，什么都不想干。」
来源: 7c5b2e1a`

describe('stripDiaryHeader', () => {
  it('drops the bank memType header and the cycle label', () => {
    const body = stripDiaryHeader(DIARY)
    expect(body.startsWith('# 2026-11-01')).toBe(true)
    expect(body).not.toContain('情感记忆')
    expect(body).not.toContain('[自循环日记]')
  })
})

describe('diaryTitle', () => {
  it('keeps the part after the date dot', () => {
    expect(diaryTitle(DIARY)).toBe('疲惫到不想做任何事')
  })
  it('falls back to the first line when there is no dot', () => {
    expect(diaryTitle('今天想了很多')).toBe('今天想了很多')
  })
  it('skips the state/boilerplate lines and quotes the user instead', () => {
    const statusDiary = `# 情感记忆: [自循环日记]

[自循环日记]
角色自我状态：情绪指数 +0.0；精力：100/100。
本轮互动状态估计：neutral（v=0.26 a=0.08 d=-0.17）。这是互动传感器估计，不是用户事实。
近期互动记录：
- 用户: 今天累死了，什么都不想干。
记录用途：整理当前状态与近期互动。`
    expect(diaryTitle(statusDiary)).toBe('今天累死了，什么都不想干')
  })

  it('cuts her own reply out of the quote line', () => {
    const line = diaryTitle('近期互动记录：\n- 用户: 今天累死了，什么都不想干。 助手: 嗯，我知道的。 那就什么都不用干了。')
    expect(line).toBe('今天累死了，什么都不想干')
  })

  it('is undefined for empty input', () => {
    expect(diaryTitle('   ')).toBeUndefined()
  })
})

describe('screenBusy', () => {
  it('reads a meeting as busy', () => {
    expect(screenBusy('腾讯会议正在共享屏幕，有 6 个人在会议中').busy).toBe(true)
  })
  it('reads a game as busy', () => {
    expect(screenBusy('全屏的 Steam 游戏画面').busy).toBe(true)
  })
  it('fails open on an ordinary desktop', () => {
    expect(screenBusy('Chrome 里一个 Gemini 页面，标题是 AIRI 新版本').busy).toBe(false)
  })
  it('treats a missing line as idle', () => {
    expect(screenBusy(undefined).busy).toBe(false)
  })
})

describe('composeInnerVoice', () => {
  it('says the diary title back to herself, in first person', () => {
    const line = composeInnerVoice({ diary: DIARY, drives: idle, now: 0 })
    expect(line).toContain('疲惫到不想做任何事')
    expect(line).not.toContain('情感记忆')
    expect(line).not.toContain('摘录')
  })

  it('holds the tongue when the screen says busy', () => {
    const line = composeInnerVoice({
      diary: DIARY,
      screen: '腾讯会议正在共享屏幕',
      heldReason: 'busy-screen',
      drives: bored,
      now: 0,
    })
    expect(line).toContain('不打扰')
  })

  it('adds the drive when curiosity is high', () => {
    const line = composeInnerVoice({ diary: DIARY, drives: { ...idle, curiosity: 80 }, now: 0 })
    expect(line).toContain('想知道点什么')
  })

  it('returns nothing when there is nothing to think about', () => {
    expect(composeInnerVoice({ drives: idle, now: 0 })).toBeUndefined()
  })
})
