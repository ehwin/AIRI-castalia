import type { Recipe } from '@proj-airi/core-agent'

/** Format rules that the chat renderer needs from every reply. */
export const CHAT_FORMAT_RULES = `${[
  // Only listed languages load in the renderer, so every code block names its language.
  '- For any programming code block, always specify the programming language that supported on @shikijs/rehype on the rendered markdown, eg. ```python ... ```',
  '- Use $$...$$ for inline math.',
  '- Use a separate multiline $$ block for each display equation.',
  '- Use a latex fence for a list of independent one-line equations.',
  '- Use a math fence for one multiline equation or LaTeX environment.',
  '- Do not use single dollar signs as math delimiters.',
].join('\n')}\n`

/**
 * Local zone of this machine as `Area/City (UTC+08:00)`.
 *
 * Use when:
 * - The clock rule names the zone a message prefix is written in. It only changes when
 *   the machine's zone does, so it can sit in the cacheable prompt prefix.
 */
export function localZoneLabel(now: Date = new Date()): string {
  const minutes = -now.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const offset = `UTC${sign}${Math.floor(absolute / 60).toString().padStart(2, '0')}:${(absolute % 60).toString().padStart(2, '0')}`
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return zone ? `${zone} (${offset})` : offset
  }
  catch {
    return offset
  }
}

/**
 * Clock rule: what the per-message prefix means.
 *
 * Use when:
 * - A chat run starts. It holds no runtime clock value, so the prefix keeps its bytes and
 *   the prompt cache stays valid across turns and days.
 */
export function composeClockRule(zone: string) {
  return `- Every owner message starts with [YYYY-MM-DD HH:MM], the local time it reached you in ${zone}. The newest prefix is the current time, so answer from it whenever the time or date matters. It is metadata: never repeat it back.\n`
}

/**
 * Builds the system prompt of one run: format rules, the clock rule, then the identity of the run's persona.
 *
 * Use when:
 * - A chat run starts. Identity is read for its persona then, so history never stores it.
 */
export function composeSystemPrompt(identity: string, zone: string = localZoneLabel()) {
  return CHAT_FORMAT_RULES + composeClockRule(zone) + identity
}

/**
 * Prompt part of a session that is a recipe's own space. It follows the identity and stays the same for every run there, so the prefix stays cacheable.
 * The recipe reports a result to the conversation.
 */
export function composeRecipeSpacePrompt(recipe: Recipe) {
  const purpose = recipe.description.trim() ? `Purpose: ${recipe.description.trim()}\n` : ''
  const steps = `${purpose}Recipe steps:\n${recipe.instructions.trim()}`
  return `\n\nYou run the recipe "${recipe.name}" in its own space for your conversation with the owner. Each message here is a task from that conversation. Your reply is the recipe's result: the conversation receives it and decides what to tell the owner, so report what you found or did, briefly.\n\n${steps}`
}
