export type { AgentContextPort } from './contracts/context-port'
export type { ChatHookRegistry } from './contracts/hook-types'
export type { AgentLLMPort } from './contracts/llm-port'
export type { AgentSessionPort } from './contracts/session-port'
export type { AgentForegroundStreamPort } from './contracts/stream-port'
export { chatContentToInputSegments, chatMessagesToTurns, conversationToChatMessages } from './messages/chat-completions'
export {
  buildContextPromptMessage,
  formatContextPromptText,
} from './messages/context-prompt'
export type { ContextSnapshot } from './messages/context-prompt'

export { formatTimePrefix } from './messages/datetime-prefix'
export { renderConversationPreview } from './messages/preview'
export type { AssistantTurn, Citation, ContentSegment, Conversation, GenerationRound, ProviderContinuation, SystemTurn, ToolExecution, ToolInvocation, Turn, UserTurn } from './messages/types'
// NOTICE: the fork's stores import persona/mind helpers straight from the package root
// (scanRetention, advanceDrives, blindSense, composeThought). Upstream's 0.13 entry never
// re-exported these sub-entries, so the merged tree lost them and the app build failed with
// MISSING_EXPORT. Re-export both sub-entries; drop these lines once upstream's entry does it.
export * from './mind'
export * from './persona'
export { createChatHooks } from './runtime/agent-hooks'
export type {
  ChatAttachment,
  ChatOrchestratorLifecycleRecord,
  ChatOrchestratorLLMPort,
  ChatOrchestratorPromptProjection,
  ChatOrchestratorRuntime,
  ChatOrchestratorRuntimeDeps,
  ChatOrchestratorRuntimeState,
  ChatOrchestratorSendOptions,
  ChatOrchestratorSessionPort,
  QueuedSendSnapshot,
  ToolContent,
} from './runtime/chat-orchestrator-runtime'
export { createChatOrchestratorRuntime } from './runtime/chat-orchestrator-runtime'
export type { ContextHistoryEntry, ContextIngestResult, ContextRegistry } from './runtime/context-registry'
export { createContextRegistry } from './runtime/context-registry'
export { useLlmmarkerParser } from './runtime/llm-marker-parser'
export {
  isContentArrayRelatedError,
  isToolRelatedError,
  modelKey,
  streamFrom,
} from './runtime/llm-service'
export { decisionOptions, dueRecipes, isBackgroundRecipe, judgeDecision, matchKeywordRecipes, MIN_AUTO_RUN_MINUTES, MODEL_DECIDES_STEPS, nextRunAt, usableRecipes } from './runtime/recipe'
export type { DecisionAction, DecisionOption, DecisionQuestion, Recipe, RecipeDecision, RecipeSchedule } from './runtime/recipe'
export {
  categorizeResponse,
  createStreamingCategorizer,
} from './runtime/response-categoriser'
export type {
  CategorizedResponse,
  CategorizedSegment,
  ResponseCategory,
} from './runtime/response-categoriser'

export { mergeLoadedSessionMessages } from './session/merge-loaded-session-messages'
export type {
  ChatAssistantMessage,
  ChatHistoryItem,
  ChatInvokedSkill,
  ChatMessage,
  ChatSlices,
  ChatSlicesCard,
  ChatSlicesSticker,
  ChatSlicesText,
  ChatSlicesToolCall,
  ChatSlicesToolCallResult,
  ChatSlicesToolContent,
  ChatStreamEvent,
  ChatStreamEventContext,
  ChatToolReference,
  ContextMessage,
  ErrorMessage,
  StreamingAssistantMessage,
} from './types/chat'

export type {
  BuiltinToolsResolver,
  StreamEvent,
  StreamFromOptions,
  StreamOptions,
} from './types/llm'
export * from './voice'
