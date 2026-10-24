/**
 * The one line the model reads about the companion's own state.
 *
 * A persona prompt describes who the character is. It does not describe how
 * this afternoon went. Without that line every reply has the same cheerfulness,
 * whatever the drives say.
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

const level = (value: number) => {
  if (value >= 75) return 'high'
  if (value >= 45) return 'mid'
  if (value >= 20) return 'low'
  return 'none'
}

/**
 * Renders a compact state prefix, or an empty string when nothing is worth
 * saying. An always-present line becomes noise the model learns to ignore.
 */
export function renderStateLine(input: StateLineInput): string {
  const { fatigue, boredom, curiosity, focus } = input.drives
  const parts: string[] = []

  if (fatigue >= 45) parts.push(`tired=${level(fatigue)}`)
  if (boredom >= 45) parts.push(`bored=${level(boredom)}`)
  if (curiosity >= 45) parts.push(`curious=${level(curiosity)}`)
  if (focus >= 60) parts.push(`focused=${level(focus)}`)
  if (input.slept) parts.push('just-woke-up')
  if (input.heldBack) parts.push('holding-something-back')

  if (parts.length === 0)
    return ''

  return `[self: ${parts.join(', ')}]`
}
