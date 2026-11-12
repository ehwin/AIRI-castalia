/**
 * Turns a day of private thoughts into one memory entry.
 *
 * The diary is hers. Keeping every line forever is not memory, it is a log.
 * This picks a few lines that are worth remembering and drops the rest, so the
 * same day can be recalled without becoming a transcript.
 *
 * Source: Generative Agents (Park et al., UIST 2023) reflects over a stream
 * into higher-level insights, then keeps the stream separate from them.
 */
import type { Thought } from './inner-stream'

export interface DiaryEntry {
  name: string
  description: string
  body: string
}

export interface DistillOptions {
  /** `YYYY-MM-DD`. Used as the entry name so a day has exactly one memory. */
  date: string
  /** How many lines survive. */
  max?: number
}

function line(thought: Thought) {
  const time = new Date(thought.at)
  const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  return `- ${clock} ${thought.text.replace(/^noticed:\s*/, '')}`
}

/**
 * Picks what a day is remembered by.
 *
 * A thought she chose to say outranks one she kept, because the user already
 * heard it. The rest spreads across the day instead of clustering at its start.
 */
export function distillDay(thoughts: Thought[], options: DistillOptions): DiaryEntry | undefined {
  const max = options.max ?? 3
  const ofDay = thoughts
    .filter(thought => thought.text.trim().length > 0)
    .sort((left, right) => left.at - right.at)

  if (ofDay.length === 0)
    return undefined

  const shared = ofDay.filter(thought => thought.visibility === 'shared')
  const rest = ofDay.filter(thought => thought.visibility !== 'shared')

  // Even spacing keeps a long day from collapsing into its first hour.
  const spaced: Thought[] = []
  // Never ask for more slots than there are thoughts left: clamping the index afterwards repeated
  // the same line two or three times in the memory body on a quiet day.
  const slots = Math.max(0, Math.min(max - shared.length, rest.length))
  for (let index = 0; index < slots && rest.length > 0; index++) {
    const at = Math.floor((index + 0.5) * rest.length / slots)
    spaced.push(rest[Math.min(rest.length - 1, at)])
  }

  const picked = [...shared, ...spaced].slice(0, max)
  if (picked.length === 0)
    return undefined

  const first = picked[0].text.replace(/^noticed:\s*/, '')
  return {
    name: `diary-${options.date}`,
    description: first.length > 80 ? `${first.slice(0, 79)}…` : first,
    body: picked.map(line).join('\n'),
  }
}
