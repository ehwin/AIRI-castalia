/**
 * The one line the model reads about the companion's own state.
 *
 * A persona prompt describes who the character is. It does not describe how
 * this afternoon went. Without that line every reply has the same cheerfulness,
 * whatever the drives say.
 *
 * The wording is plain narration on purpose. AIRI renders runtime context as a
 * `[Context]` bullet list prefixed with its context id, and weak models mirror
 * conspicuous wrappers back into their replies (moeru-ai/airi#1539). Brackets,
 * key=value pairs, and system-looking ids are three chances to be quoted back
 * as if they were her own words, so this line has none of them.
 *
 * Source: ALMA (Gebhard, 2005) maps an emotional state onto behaviour through a
 * small, explicit summary. This is the smallest useful version of that idea.
 */
import type { Drives } from '../mind/drives'

export interface StateLineInput {
  drives: Drives
  /** The companion just came back from a long absence. */
  slept?: boolean
  /** It wanted to say something and did not. */
  heldBack?: boolean
}

/**
 * Renders a compact state line, or an empty string when nothing is worth saying.
 * An always-present line becomes noise the model learns to ignore.
 */
export function renderStateLine(input: StateLineInput): string {
  const { fatigue, boredom, curiosity, focus } = input.drives
  const parts: string[] = []

  if (fatigue >= 75)
    parts.push('very tired')
  else if (fatigue >= 45)
    parts.push('tired')

  if (boredom >= 75)
    parts.push('very bored')
  else if (boredom >= 45)
    parts.push('a little bored')

  if (curiosity >= 45)
    parts.push('curious about something')

  if (focus >= 60)
    parts.push('absorbed in work')

  if (input.slept)
    parts.push('just woke up')
  if (input.heldBack)
    parts.push('holding something back')

  return parts.slice(0, 3).join(', ')
}
