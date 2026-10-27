import type { ChatAssistantMessage, ChatHistoryItem } from '@proj-airi/core-agent'

/**
 * Extract a plain-text payload from a local `ChatHistoryItem`.
 *
 * Use when:
 * - A consumer needs the readable text of a message, such as a session
 *   preview, a notice pill, or the spotlight overlay.
 *
 * Expects:
 * - Tool-result and tool-call slices are dropped silently. The text of a
 *   card slice is its own paragraph.
 *
 * Returns:
 * - The text and card slices for assistant messages with slice arrays.
 *   Otherwise the message content as text. Empty string when nothing is
 *   extractable.
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
