import type { RetentionCategory, RetentionVerdict } from '@proj-airi/core-agent'
import type { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import type { Message } from '@xsai/shared-chat'

import type { ContextMessage } from '../../types/chat'

import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { formatContextPromptText } from '../chat/context-prompt'

export type ContextLifecyclePhase
  = | 'server-received'
    | 'input-context-update'
    | 'broadcast-posted'
    | 'broadcast-received'
    | 'store-ingested'
    | 'store-ingest-rejected'
    | 'before-compose'
    | 'prompt-context-built'
    | 'after-compose'

export interface ContextLifecycleRecord {
  id: string
  timestamp: number
  phase: ContextLifecyclePhase
  channel: 'server' | 'broadcast' | 'chat' | 'input'
  sourceKey?: string
  sessionId?: string
  strategy?: ContextUpdateStrategy
  lane?: string
  contextId?: string
  eventId?: string
  mutation?: 'replace' | 'append'
  textPreview?: string
  sourceLabel?: string
  details?: unknown
}

export interface PromptProjectionSnapshot {
  capturedAt: number
  sessionId: string
  message: string
  contexts: Record<string, ContextMessage[]>
  promptText: string
  promptMessage?: Message
  composedMessage?: Message[]
}

const DEFAULT_MAX_HISTORY = 200
// Enough to see whether a change to the prompt helped, without keeping a transcript.
const DEFAULT_MAX_RETENTION_REDLINES = 50
const DEFAULT_MAX_CRISIS_AUDITS = 50

function truncateText(value: string, limit = 220) {
  if (value.length <= limit)
    return value
  return `${value.slice(0, limit)}...`
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value)
  }
  catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

/**
 * One turn that the crisis watch treated as more than an ordinary turn.
 *
 * Categories, level and the resource flag only: the audit answers "did every
 * safety turn hand over a way to reach a person", never "what did the user say".
 */
export interface CrisisAuditEntry {
  at: number
  level: 'elevated' | 'crisis' | 'normal'
  categories: string[]
  resourcesOffered: boolean
  escalated: boolean
}

/**
 * One reply that carried a red line.
 *
 * The categories are a fixed vocabulary and the snippet is her own words, copied
 * so the devtools page can show what tripped it. Nothing a user wrote lands here.
 */
export interface RetentionRedlineRecord {
  at: number
  verdict: RetentionVerdict
  categories: RetentionCategory[]
  hard: boolean
  snippet: string
}

export const useContextObservabilityStore = defineStore('devtools:context-observability', () => {
  const history = ref<ContextLifecycleRecord[]>([])
  const maxHistory = ref(DEFAULT_MAX_HISTORY)
  const lastPromptProjection = ref<PromptProjectionSnapshot>()
  const lastBroadcastPostedAt = ref<number>()
  const lastBroadcastReceivedAt = ref<number>()
  const retentionRedlines = ref<RetentionRedlineRecord[]>([])
  const maxRetentionRedlines = ref(DEFAULT_MAX_RETENTION_REDLINES)
  const crisisAudits = ref<CrisisAuditEntry[]>([])
  const maxCrisisAudits = ref(DEFAULT_MAX_CRISIS_AUDITS)

  function recordLifecycle(record: Omit<ContextLifecycleRecord, 'id' | 'timestamp' | 'textPreview'> & { textPreview?: string }) {
    const nextRecord: ContextLifecycleRecord = {
      id: nanoid(),
      timestamp: Date.now(),
      ...record,
      textPreview: record.textPreview ? truncateText(record.textPreview) : undefined,
      details: record.details === undefined ? undefined : cloneValue(record.details),
    }

    history.value.unshift(nextRecord)
    if (history.value.length > maxHistory.value) {
      history.value.splice(maxHistory.value)
    }

    if (record.phase === 'broadcast-posted')
      lastBroadcastPostedAt.value = nextRecord.timestamp
    if (record.phase === 'broadcast-received')
      lastBroadcastReceivedAt.value = nextRecord.timestamp

    return nextRecord
  }

  function capturePromptProjection(payload: {
    sessionId: string
    message: string
    contexts: Record<string, ContextMessage[]>
    promptMessage?: Message | null
    composedMessage?: Message[]
  }) {
    lastPromptProjection.value = {
      capturedAt: Date.now(),
      sessionId: payload.sessionId,
      message: payload.message,
      contexts: cloneValue(payload.contexts),
      promptText: formatContextPromptText(payload.contexts),
      promptMessage: payload.promptMessage ? cloneValue(payload.promptMessage) : undefined,
      composedMessage: payload.composedMessage ? cloneValue(payload.composedMessage) : undefined,
    }
  }

  function captureProviderPromptProjection(sessionId: string, composedMessage: Message[]) {
    if (lastPromptProjection.value?.sessionId !== sessionId)
      return

    lastPromptProjection.value = {
      ...lastPromptProjection.value,
      capturedAt: Date.now(),
      composedMessage: cloneValue(composedMessage),
    }
  }

  /**
   * Record that her own reply tried to hold the user here.
   *
   * The instructions in the prompt forbid it, and a red line still gets written
   * from time to time, so the count of what got through is the only honest way to
   * tell whether the constraint works on the model in use.
   */
  function recordRetentionRedline(payload: { text: string, verdict: RetentionVerdict, categories: RetentionCategory[], hard: boolean }) {
    const record: RetentionRedlineRecord = {
      at: Date.now(),
      verdict: payload.verdict,
      categories: [...payload.categories],
      hard: payload.hard,
      snippet: truncateText(payload.text),
    }
    retentionRedlines.value.unshift(record)
    if (retentionRedlines.value.length > maxRetentionRedlines.value)
      retentionRedlines.value.splice(maxRetentionRedlines.value)
    return record
  }

  /** Record one turn that reached the safety side of the crisis watch. */
  function recordCrisisAudit(entry: CrisisAuditEntry) {
    const record: CrisisAuditEntry = { ...entry, categories: [...entry.categories] }
    crisisAudits.value.unshift(record)
    if (crisisAudits.value.length > maxCrisisAudits.value)
      crisisAudits.value.splice(maxCrisisAudits.value)
    return record
  }

  function clearHistory() {
    history.value = []
  }

  return {
    history,
    retentionRedlines,
    maxRetentionRedlines,
    recordRetentionRedline,
    crisisAudits,
    maxCrisisAudits,
    recordCrisisAudit,
    maxHistory,
    lastPromptProjection,
    lastBroadcastPostedAt,
    lastBroadcastReceivedAt,
    recordLifecycle,
    capturePromptProjection,
    captureProviderPromptProjection,
    clearHistory,
  }
})
