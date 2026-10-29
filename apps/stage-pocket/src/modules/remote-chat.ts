import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'
import type { ChatSendPayload, ChatSendResult } from '@proj-airi/stage-ui/stores/chat'

import { nanoid } from 'nanoid'

import { setRemoteChatTransport } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'

/**
 * Binding prefix that marks a turn as this device's. The host resolves the whole string to a persistent persona
 * session, so the suffix is opaque to it and only has to come back unchanged.
 */
const BINDING_PREFIX = 'pocket:'

/** A stored turn carries an identity, which the message types leave optional. */
type StoredUserMessage = Extract<ChatHistoryItem, { role: 'user' }> & { id: string }
type StoredAssistantMessage = Extract<ChatHistoryItem, { role: 'assistant' }> & { id: string }

/** A host turn includes memory recall, model latency and speech, so the ceiling is generous. */
const TURN_TIMEOUT_MS = 180_000

interface PendingTurn {
  /** Identity of the assistant message this turn writes back into the local session. */
  assistantId: string
  /** Last complete text the host sent. A streaming turn overwrites it on every message. */
  text: string
  settle: (reply: string) => void
  timer: ReturnType<typeof setTimeout>
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string')
    return content
  if (Array.isArray(content))
    return content.map(part => (part as { text?: string } | undefined)?.text ?? '').join('')
  return ''
}

/**
 * The host echoes the originating input event back on every reply, so the turn is identifiable from the reply alone.
 * The binding lives in the input overrides rather than in a transport field, because that is the only place the
 * orchestrator keeps it while it runs.
 */
function bindingOf(event: unknown): string | undefined {
  const source = (event as Record<string, any> | undefined)?.['gen-ai:chat']
  const binding = source?.input?.data?.overrides?.binding
  return typeof binding === 'string' ? binding : undefined
}

/**
 * Forwards every chat turn to the desktop instance, which owns the persona, the model and the memory bank.
 *
 * The phone keeps a local copy of the transcript so the conversation survives being offline, but it never runs an
 * orchestrator of its own while this transport is installed: two answers to one message would be worse than none.
 */
export function installRemoteChat() {
  const chatSession = useChatSessionStore()
  const channel = useModsServerChannelStore()
  const pending = new Map<string, PendingTurn>()

  /**
   * The host reports a turn twice: once per streamed message and once when it completes. Only the completion settles
   * the promise, so a turn that stops sending without completing still fails loudly instead of hanging.
   */
  const listen = (type: 'output:gen-ai:chat:message' | 'output:gen-ai:chat:complete') =>
    channel.onEvent(type, async (event) => {
      const binding = bindingOf(event.data)
      if (!binding?.startsWith(BINDING_PREFIX))
        return

      const turn = pending.get(binding)
      if (!turn)
        return

      const text = textOf((event.data as { message?: unknown }).message)
      if (text)
        turn.text = text

      if (type !== 'output:gen-ai:chat:complete')
        return

      pending.delete(binding)
      clearTimeout(turn.timer)
      turn.settle(turn.text)
    })

  const offMessage = listen('output:gen-ai:chat:message')
  const offComplete = listen('output:gen-ai:chat:complete')

  setRemoteChatTransport({
    // The link drops whenever the phone leaves the tailnet, so the transport stays installed and steps aside.
    canSend: () => channel.connected,

    async send(payload: ChatSendPayload): Promise<ChatSendResult> {
      // The turn is recorded locally as well, and a session that was never created cannot hold a message.
      if (!chatSession.sessionMetas[payload.sessionId])
        throw new Error('This chat session is not ready yet')

      const binding = `${BINDING_PREFIX}${payload.sessionId}`
      const assistantId = nanoid()
      const userMessage = {
        id: payload.messageId ?? nanoid(),
        role: 'user',
        content: [{ type: 'text', text: payload.text }],
      } as StoredUserMessage

      // The user message lands before the request so a failed turn still shows what was asked.
      await chatSession.commitUserMessage(payload.sessionId, userMessage)

      const reply = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(binding)
          reject(new Error('The desktop did not finish this turn'))
        }, TURN_TIMEOUT_MS)

        pending.set(binding, { assistantId, text: '', settle: resolve, timer })

        channel.send({
          type: 'input:text',
          data: {
            text: payload.text,
            textRaw: payload.text,
            overrides: { binding },
          },
        } as any)
      })

      const assistantMessage = {
        id: assistantId,
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
      } as unknown as StoredAssistantMessage

      await chatSession.storeMessage(payload.sessionId, assistantMessage)

      return { sessionId: payload.sessionId, messages: [userMessage, assistantMessage] }
    },
  })

  return () => {
    offMessage()
    offComplete()
    setRemoteChatTransport(null)
  }
}
