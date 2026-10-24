/**
 * Ports the turn loop depends on.
 *
 * The loop never imports a provider, a database, or a store. Everything it
 * needs arrives as one of these small interfaces, so a test runs without a
 * model and a host can swap an adapter.
 */

/** One call the model asked for. */
export interface ToolCall {
  callId: string
  name: string
  /** JSON encoded arguments, exactly as the model produced them. */
  arguments: string
}

/** A capability the loop may run. */
export interface ToolPort {
  name: string
  /** Resolves with the text that goes back to the model. */
  run: (args: string, signal?: AbortSignal) => Promise<string>
}

/**
 * The memory the companion remembers through.
 *
 * Castalia implements this. The loop only asks for a few lines before a turn
 * and writes one line after it. Retrieval strategy stays on that side, because
 * a second retrieval layer would compete with it.
 */
export interface MemoryPort {
  /** Returns the few memories worth putting in front of the model. */
  recall: (query: string, limit?: number) => Promise<string[]>
  /** Records one finished exchange. */
  record: (input: { text: string, tags?: string[] }) => Promise<void>
}

/** A memory that remembers nothing, for tests and for hosts without Castalia. */
export const emptyMemory: MemoryPort = {
  recall: async () => [],
  record: async () => {},
}
