import type { ChatAssistantMessage, ChatHistoryItem } from '@proj-airi/core-agent'

/**
 * Extract a plain-text payload from a local `ChatHistoryItem`.
 *
 * Use when:
 * - A list needs one line for a message: the sessions drawer and the notice row.
 *
 * Expects:
 * - Tool-result and tool-call slices are dropped silently. The text is for display, not for a
 *   round-trip through the wire format the hosted sync used.
 * - A card uploads as its text, in its own paragraph.
 *
 * Returns:
 * - The text and card slices for assistant messages with slice arrays; otherwise
 *   the message's stringified content. Empty string when nothing extractable.
 */
export function extractMessageText(message: ChatHistoryItem): string {
  if (message.role === 'assistant') {
    // The discriminated union narrows `message` to a shape that includes
    // `slices`; reading via the narrowed alias keeps tsc happy without an
    // `as` cast.
    const assistant: ChatAssistantMessage = message
    if (Array.isArray(assistant.slices) && assistant.slices.length > 0) {
      // Text slices of one run join as they streamed. A card ends the run and adds its text as a paragraph.
      const blocks: string[] = []
      let run = ''
      for (const slice of assistant.slices) {
        if (slice.type === 'text') {
          run += slice.text
        }
        else if (slice.type === 'card') {
          blocks.push(run, slice.text)
          run = ''
        }
      }
      blocks.push(run)
      const text = blocks.filter(Boolean).join('\n\n')
      if (text)
        return text
    }
  }
  if (typeof message.content === 'string')
    return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string')
          return part
        if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part)
          return String(part.text ?? '')
        return ''
      })
      .join('')
  }
  return ''
}
