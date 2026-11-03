import type { ContextMessage } from '../types/chat'

export interface AgentContextPort {
  ingest: (envelope: ContextMessage) => void
  /** `sessionId` lets a host drop context that belongs to another conversation. */
  snapshot: (sessionId?: string) => Record<string, ContextMessage[]>
  reset: () => void
}
