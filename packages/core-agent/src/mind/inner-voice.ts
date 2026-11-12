/**
 * The inner voice: what she says to herself, not to the user.
 *
 * A self-cycle writes a diary entry — evidence, quotes, a title. That is a record,
 * not a thought: reading it out would be quoting a file. This module turns the
 * record plus what she just saw on screen into one short first-person line, the
 * way a person rephrases their own day in their head.
 *
 * Pure on purpose. The mind store owns the clock and the drives; this only words
 * them, so the phrasing is testable without a browser or a model.
 */
import type { Drives } from './drives'

export interface InnerVoiceMaterial {
  /** The diary body a self-cycle just wrote. May carry the bank's memType header. */
  diary?: string
  /** One line of screen description, from the sense port. */
  screen?: string
  /** Why she decided not to speak, when she wanted to. */
  heldReason?: HeldBackReason
  /** 她自己最近想过的几句（新的在最后）。自言自语要有连续性，不能每句都像第一次开口。 */
  previous?: string[]
  drives: Drives
  now: number
}

export type HeldBackReason = 'busy-screen' | 'quiet-hours' | 'tired'

/** The bank prepends `# 情感记忆:` and the cycle writes `[自循环日记]` — neither is hers. */
export function stripDiaryHeader(text: string): string {
  return text
    .replace(/^\s*#+\s*情感记忆\s*[:：]?\s*/u, '')
    .replace(/^\s*\[自循环日记\]\s*/u, '')
    .replace(/^\s*\[[^\]]{0,20}\]\s*/u, '')
    .trim()
}

/** 日记里的固定抬头/落款，都不是她脑子里的内容。 */
const BOILERPLATE = /^(角色自我状态|本轮互动状态估计|近期互动记录|记录用途|摘录|来源|人物|未完)\s*[:：]?/u

/**
 * The diary title: its first real line.
 *
 * A self-cycle entry opens with a title such as `# 2026-11-01 · 疲惫到不想做任何事`.
 * Keeping only the part after the dot leaves the thing she would actually think
 * about, instead of a date.
 */
export function diaryTitle(text: string): string | undefined {
  const lines = stripDiaryHeader(text)
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*•]\s*/u, '').trim())
    .filter(line => line && !BOILERPLATE.test(line))

  // 标题形态优先：`2026-11-01 · 疲惫到不想做任何事` → 取点号后面那句。
  const titled = lines.find(line => /·/u.test(line))
  if (titled)
    return titled.split('·').pop()?.trim().slice(0, 40)

  // 退而求其次：日记里最具体的一句是主人原话，去掉「用户:」前缀。
  const quote = lines.find(line => /^用户\s*[:：]/u.test(line))
  if (quote) {
    // 一行里常把她的回应也串在一起（`用户: … 助手: …`）；她心里反复的是主人那句。
    // 主语在下面拼句时用「主人」，不写「她」——写「她」会把主人的状态安到她身上。
    const said = quote
      .replace(/^用户\s*[:：]\s*/u, '')
      .split(/\s+助手\s*[:：]/u)[0]
      .replace(/^[「『"]|[」』"]$/gu, '')
      .replace(/[。！？…\s]+$/u, '')
      .trim()
    return said ? said.slice(0, 30) : undefined
  }

  const first = lines[0]?.replace(/^#+\s*/u, '').trim()
  return first ? first.slice(0, 40) : undefined
}

/**
 * Does this screen line say "do not interrupt"?
 *
 * The sense port returns one sentence from the vision workload, so this is a
 * keyword read, not a classifier. It fails open: a line it does not recognise is
 * treated as idle, because a companion that misreads a caption should still be
 * allowed to say good evening. The cost of a wrong "busy" is silence; the cost of
 * a wrong "idle" is one interruption, which the outbound gate already limits.
 */
const BUSY_PATTERNS: Array<[RegExp, string]> = [
  [/会议|腾讯会议|zoom|teams|飞书会议|webex|meet\b/iu, 'an online meeting'],
  [/演示|幻灯片|幻灯片放映|presentation|slideshow/iu, 'a presentation'],
  [/直播|视频通话|录屏|screen ?share|共享屏幕/iu, 'a call or a screen share'],
  [/全屏|fullscreen|独占全屏/iu, 'a fullscreen app'],
  [/游戏|steam|艾尔登|原神|lol|valorant/iu, 'a game'],
  [/编译|构建|运行测试|terminal|终端|命令行/iu, 'a terminal in the middle of something'],
  [/代码编辑器|编辑器|ide|vs ?code|cursor|sublime|pycharm|jetbrains/iu, 'a code editor she is working in'],
  [/写文档|文档|笔记|笔记软件|markdown|word|notion|obsidian|语雀|飞书文档/iu, 'a document being written or read'],
  [/阅读|论文|pdf|读书|长文/iu, 'something being read'],
  [/正在输入|视频渲染|导出中|下载中|进度 \d+%/u, 'a job still running'],
]

export function screenBusy(line: string | undefined): { busy: boolean, reason?: string } {
  const text = String(line ?? '').trim()
  if (!text)
    return { busy: false }
  for (const [pattern, reason] of BUSY_PATTERNS) {
    if (pattern.test(text))
      return { busy: true, reason }
  }
  return { busy: false }
}

/**
 * 这句话和上一句讲的是不是同一件事。
 *
 * 只做字面判断：两句话里有没有三个字以上的公共片段。宁可漏判（当成新话题），也不要把
 * 「还在想」安到别的念头上——那会让她显得在重复自己。
 */
export function sameSubject(previous: string, current: string): boolean {
  const a = String(previous ?? '')
  const b = String(current ?? '').replace(/^她/u, '')
  if (!a || !b)
    return false
  for (let i = 0; i + 3 <= b.length; i++) {
    if (a.includes(b.slice(i, i + 3)))
      return true
  }
  return false
}

/**
 * A screen line short enough to sit inside a sentence.
 *
 * The vision workload answers in markdown-ish English (`**Active App/Page:** …`,
 * `### Screen Interpretation`, bullet lists). Quoting that inside a thought reads
 * like a log dump, so field labels and markup come off first; a cut that would
 * end mid-word drops the partial word instead of leaving `60 f…`.
 */
export function screenSummary(line: string | undefined, max = 26): string | undefined {
  let text = String(line ?? '')
  text = text.replace(/\*\*|__|`|#{2,}/gu, ' ')
  text = text.replace(/^\s*[-*•]\s*/gmu, ' ')
  text = text.replace(/(active app\/page|foreground|background|key ui elements?|state)\s*[:：]?/giu, ' ')
  text = text.replace(/\s+/gu, ' ').replace(/^[\s:：·\-,]+/u, '').trim()
  if (!text)
    return undefined
  if (text.length <= max)
    return text
  const cut = text.slice(0, max).replace(/\s+\S*$/u, '').trim()
  return `${cut || text.slice(0, max)}…`
}

/**
 * One line of self-talk.
 *
 * Order matters: a held-back urge is the most immediate thing in her head, then
 * what she just worked out, then what she is looking at. With nothing to say it
 * returns undefined — an empty head is honest, and a fabricated thought is not.
 */
export function composeInnerVoice(material: InnerVoiceMaterial): string | undefined {
  const title = material.diary ? diaryTitle(material.diary) : undefined
  const prev = (material.previous ?? []).map(line => String(line ?? '').trim()).filter(Boolean)
  const lastPrev = prev[prev.length - 1]
  const brief = screenSummary(material.screen)
  const { boredom, curiosity } = material.drives
  const mood = boredom >= 60 ? '有点闷' : curiosity >= 60 ? '想知道点什么' : ''

  if (material.heldReason === 'busy-screen') {
    const what = brief ? `屏幕上${brief}` : '屏幕上像是忙着'
    return `${what}……算了，先不打扰。`
  }
  if (material.heldReason === 'tired')
    return '困得脑子发钝，今天先不想了。'
  if (material.heldReason === 'quiet-hours')
    return '这个点不该出声，留到明天吧。'

  const said = title?.replace(/[。！？…\s]+$/u, '')
  // 接得上上一句时先接上：脑子里的话是一条线，不是一串独立短句。
  const again = Boolean(lastPrev && said && sameSubject(lastPrev, said))
  const lead = again ? '还在想刚才那件事——' : ''
  if (said && brief)
    return `${lead}主人${said}……刚看到${brief}，${mood || '先记着'}。`
  if (said)
    return `${lead}主人${said}……${mood || '先记着，不急'}。`
  if (brief)
    return `${mood ? `${mood}——` : ''}屏幕上${brief}，没什么要说的。`
  return undefined
}
