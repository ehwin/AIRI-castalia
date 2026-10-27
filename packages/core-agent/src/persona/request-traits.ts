/**
 * Reading a request from its text alone.
 *
 * Friction needs three numbers: how dull the work is, how messy the input is,
 * and how long it will take. The host has only the message text at send time,
 * so this guesses from shape. The guess is coarse on purpose; a wrong guess
 * costs one grumble, not a wrong answer.
 */
import type { RequestTraits } from './friction'

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Words that ask for rework rather than an answer. */
const CHORE_WORDS = /\b(?:clean\s*up|reformat|reorder|proofread|sort|summari[sz]e|refactor|rename)\b/i
const CHORE_WORDS_CJK = /整理|格式化|重排|校对|排序|归纳|摘要|重构|改名/

/** Whether the request asks for rework rather than an answer. Only chores can be refused. */
export interface RequestTraitsWithKind extends RequestTraits {
  isChore: boolean
}

export function inferRequestTraits(text: string): RequestTraitsWithKind {
  const trimmed = text.trim()
  const length = trimmed.length
  const lines = trimmed.split('\n')

  // Pasted blocks carry indentation, tabs, or very long lines.
  const indented = lines.filter(line => /^(?:\t| {2,})\S/.test(line)).length
  const veryLong = lines.filter(line => line.length > 200).length
  const mess = clamp01(indented / Math.max(1, lines.length) + veryLong / Math.max(1, lines.length))

  const isChore = CHORE_WORDS.test(trimmed) || CHORE_WORDS_CJK.test(trimmed)
  const tedium = isChore ? 0.8 : clamp01(length / 2_000)

  // A short question is a minute. A dump of 3,000 characters is not.
  const durationMin = Math.min(30, Math.round(length / 300))

  return { tedium, mess, durationMin, isChore }
}
