import { looksLikeFarewell } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Auto-created entries are named after the turn they came from, not after a fact.
 *
 * The backend writes one per finished turn (`mem-43bf085e`, description
 * `用户: … 助手: …`). Measured on the running store: 220 of 270 entries are these.
 */
/**
 * How many lines each section of the prompt index may carry.
 *
 * Three sections, because they answer three different questions: who she is, what the
 * owner is like, and what happened lately. A single recency-sorted list answered only the
 * third one: measured on the running bank, it carried 51 identity facts' worth of lore but
 * zero of them (they are unnamed prose rows), and filled every line with the last week.
 */
export const INDEX_HER_LINES = 10
export const INDEX_OWNER_LINES = 6
export const INDEX_RECENT_LINES = 4

/** One index line is a map line, not an entry: the body stays behind `read`/`search`. */
export const INDEX_LINE_CHARS = 150

/** The whole index, because the system prompt pays for it on every request. */
export const INDEX_MAX_CHARS = 1900

/**
 * How many entries one dated day may contribute to the recent section.
 *
 * The engine reruns a summary of the same evening several times, each with different
 * wording, so exact-duplicate collapsing alone still left seven lines about one tired
 * afternoon. One per day keeps the recent shape of the relationship.
 */
export const INDEX_PER_DAY = 1

/** Facts printed beside a lookup: three short rows, never the whole fact table. */
export const FACT_TOP_K = 3

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})/

const TRANSCRIPT_NAME = /^mem-[0-9a-z]{4,12}$/
const TRANSCRIPT_LINE = /^\s*(?:用户|用户说|User|user|助手|Assistant|尤诺)\s*[:：]/

/** A stale mood label. The live psyche block owns her mood; a remembered one only steers it. */
const MOOD_LINE = /^\s*\[(?:情绪快照|情绪|mood)/i

/** Her own facts read in the first person: "我出生在月食那一夜…", "「月相轮转之间…」". */
const HER_LINE = /^\s*(?:我|「[^」]{2,40}」——|在七丘|谕女)/

/** Facts about the owner: profiles, preferences, corrections. */
const OWNER_LINE = /用户|主人|小托|owner|user profile|AI 对用户的画像/i

/** What makes a fact an anchor: the parts of a persona that must not drift. */
const ANCHOR_LINE = /名字|我叫|生日|身份|出身|创造者|锚点|口头禅|母亲|谕女|忤逆|第 ?\d+ ?位/

/**
 * Whether an entry is the transcript of a turn rather than a fact.
 *
 * Use when:
 * - Building the prompt index. A transcript is recall material; it is not an index line.
 *
 * Why: the index goes into every system prompt. Filled with transcripts it spends the
 * budget on her own past register, and she imitates it — including the trailing
 * questions the closing rule exists to retire.
 *
 * The name alone is not evidence: rows ingested from the engine carry their prose under
 * `mem-<id>` and their fact is the text itself. Only a dialogue line is a transcript.
 */
export function isTranscriptEntry(entry: Pick<MemoryEntry, 'name' | 'description'> & { body?: string }): boolean {
  return TRANSCRIPT_LINE.test(entry.description)
    || TRANSCRIPT_LINE.test(entry.body ?? '')
    || (TRANSCRIPT_NAME.test(entry.name) && !entry.description.trim())
}

/**
 * Whether a finished turn is worth storing.
 *
 * Use when:
 * - A turn just finished and the memory backend is about to be asked to keep it.
 *
 * Why: a one-line goodbye carries no fact. Storing it only adds a transcript entry,
 * and `isTranscriptEntry` would then have to hide it again on the way back out.
 */
export function shouldSkipIngest(turn: { user: string, assistant: string }): boolean {
  return looksLikeFarewell(turn.user) && turn.assistant.trim().length <= 24
}

/** One remembered fact. A character keeps it on its own card. A general memory reaches every card. */
export interface MemoryEntry {
  /** Backend row id, when the backend has one. Removal uses it; the name is only the display index. */
  id?: string
  /** Short name in kebab case, unique within its scope. The index lists it, and tools address the entry by it. */
  name: string
  /** The index line: the fact itself when it fits in one line, or when the entry matters. */
  description: string
  body: string
  /** The character card that owns this memory. Without it, the owner made the memory general. */
  persona?: string
  updatedAt: number
}

/**
 * A durable store behind the in-memory entries.
 *
 * The prompt index must stay synchronous, so the local entries remain the read
 * path and this port only receives writes. A remote that is slow, offline, or
 * absent never blocks a reply.
 */
/**
 * One recall for the injection block.
 *
 * Empty `text` means nothing passed the backend's similarity gate. The caller
 * appends the block without a relevance check of its own.
 */
export interface MemoryRecall {
  text: string
  count: number
  topSim: number
  chars: number
}

/**
 * Whether the memory backend is actually answering, not merely attached.
 *
 * `attachRemote` only knows that a port object exists: MCP transports stay in place after the
 * engine behind them dies, so "attached" is exactly the flag that makes a dead backend look
 * connected. These counters are the difference between "a port is set" and "the last call worked".
 */
export interface MemoryRemoteHealth {
  attached: boolean
  okCount: number
  failureCount: number
  consecutiveFailures: number
  lastOkAt: number | null
  lastErrorAt: number | null
  lastError: string
}

export interface MemorySearchHit {
  id?: string
  text: string
  /** Backend relevance, higher is closer. 0 when the backend does not rank. */
  score: number
  memType?: string
  category?: string
  createdAt?: string
}

/** One structured fact (subject · predicate · object) that a search also found. */
export interface MemoryFact {
  subject: string
  predicate: string
  object: string
  confidence: number
  similarity?: number
}

/**
 * What a write or a forget actually achieved on the durable side.
 *
 * A tool answer is a promise to the owner, so "saved" may only be said after this resolves `ok`.
 * `refused` is the backend saying no (a shared or derived entry), `failed` is it throwing, and
 * `invalid` is the entry never being well formed enough to send.
 */
export interface MemoryPersistResult {
  ok: boolean
  reason?: 'refused' | 'failed' | 'invalid'
  error?: string
}

export interface MemoryWriteResult {
  entry?: MemoryEntry
  /** Resolves once the backend holds the entry, or once it refused and the local cache was rolled back. */
  persisted: Promise<MemoryPersistResult>
}

export interface MemoryForgetResult {
  /** True when the entry was in the local cache and is now tentatively gone. */
  found: boolean
  persisted: Promise<MemoryPersistResult>
}

/**
 * What the running backend can actually do.
 *
 * The module switch says "on"; this says whether the thing behind it can recall, search or ingest.
 * `entry-only` is the reduced local SQLite path: entries read and write, nothing else works.
 */
export interface MemoryBackend {
  transport: 'in-process' | 'stdio' | 'entry-only' | 'none'
  project?: string
  character?: string
  capabilities: { vadSweep: boolean, recall: boolean, search: boolean, facts: boolean, ingest: boolean, maintain: boolean, selfCycle: boolean, psyche: boolean }
  /** 自动情感的实验门槛：模块开着也可能一步都不推进 psyche。 */
  emotion?: { autoFromVad: boolean, estimator: 'model' | 'lexicon', note: string }
  entries?: { listed: number, truncated: boolean }
  error?: string
  checkedAt: number
}

/** Why a lookup ended: the tool must not read an unreachable backend as "this fact is absent". */
export type MemoryLookupStatus = 'ok' | 'partial' | 'unavailable' | 'failed'

export interface MemoryLookup {
  status: MemoryLookupStatus
  hits: MemorySearchHit[]
  facts: MemoryFact[]
  error?: string
}

export interface MemoryRemotePort { /** Every entry the remote holds. Replaces the local cache on start. */
  list: () => Promise<MemoryEntry[]>
  save: (entry: MemoryEntry) => Promise<void>
  /** Deletes one entry. `false` means the backend refused and kept it (shared, derived, other persona). */
  forget: (entry: Pick<MemoryEntry, 'id' | 'name' | 'persona'>) => Promise<boolean>
  /**
   * Renders a context block for one query, from the entries the backend ranks.
   *
   * A port without it leaves the recall provider with nothing to inject. The
   * recall reads ranked text, so it never serves the synchronous prompt index.
   */
  recall?: (query: string, persona?: string) => Promise<MemoryRecall>
  /**
   * Ranked lookup over the whole bank for one query.
   *
   * Different from `recall`: no injection block, no similarity gate, no character
   * budget — it answers "what does memory hold about this" for a tool call, so an
   * empty array means "nothing matched", not "nothing worth injecting".
   */
  search?: (query: string, topK?: number, persona?: string) => Promise<MemorySearchHit[]>
  /**
   * Structured facts for the same query.
   *
   * A fact is one line ("user · name · 小托"), so the search tool prints the close ones beside
   * the rows instead of spending a second call. Far-off facts are the caller's to drop.
   */
  facts?: (query: string, topK?: number, persona?: string) => Promise<MemoryFact[]>
  /**
   * Writes one finished turn into the durable store.
   *
   * Optional: a port that only stores edited entries simply does not keep a
   * conversation log. Never awaited on the reply path — a slow write must not
   * delay or fail the answer the user already sees.
   */
  ingest?: (turn: MemoryIngestTurn) => Promise<MemoryIngestResult>
}

/** One finished turn: the user's line and the assistant's final answer. */
export interface MemoryIngestTurn {
  user: string
  assistant: string
  sessionId?: string
  /** The card this turn belongs to; the backend falls back to its configured character. */
  persona?: string
}

export interface MemoryIngestResult {
  ok: boolean
  id?: string
  mode?: string
  error?: string
}

/** Turns a free name into the kebab-case key that entries use. */
export function memoryName(name: string) {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/**
 * Scores one entry for the index: recency, anchors, and stable facts first.
 *
 * Pure and deterministic, so a test can pin which lines a bank produces and the same
 * bank always renders the same prompt prefix.
 */
export function indexScore(entry: MemoryEntry, now: number) {
  const ageDays = Math.max(0, (now - (entry.updatedAt || now)) / 86_400_000)
  const recency = Math.exp(-ageDays / 45)
  const text = `${entry.name} ${entry.description}`
  const anchor = ANCHOR_LINE.test(text) ? 0.25 : 0
  const stable = HER_LINE.test(entry.description) || OWNER_LINE.test(text) ? 0.15 : 0
  return recency + anchor + stable
}

/** Character-bigram overlap, for keeping near-copies and paraphrases off the index. */
function similarity(left: string, right: string) {
  const grams = (text: string) => {
    const normalized = text.replace(/\s+/g, '')
    const set = new Set<string>()
    for (let index = 0; index < normalized.length - 1; index++)
      set.add(normalized.slice(index, index + 2))
    return set
  }
  const a = grams(left)
  const b = grams(right)
  if (!a.size || !b.size)
    return 0
  let shared = 0
  for (const gram of a) {
    if (b.has(gram))
      shared++
  }
  return shared / Math.min(a.size, b.size)
}

/**
 * Picks one section by score, then by how different it is from what is already picked.
 *
 * Why diversity: the bank holds 38 identity entries at the same importance (0.92), so a
 * pure top-K is a coin flip between "my name comes from Juno" and "my third combo has a
 * name". Maximal marginal relevance covers more of who she is per line spent.
 */
function pickDiverse(candidates: MemoryEntry[], limit: number, now: number) {
  const remaining = [...candidates]
  const picked: MemoryEntry[] = []
  while (picked.length < limit && remaining.length) {
    let best = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (const [index, entry] of remaining.entries()) {
      const overlap = picked.length
        ? Math.max(...picked.map(chosen => similarity(chosen.description, entry.description)))
        : 0
      const score = indexScore(entry, now) - 0.45 * overlap
      if (score > bestScore) {
        bestScore = score
        best = index
      }
    }
    picked.push(remaining.splice(best, 1)[0]!)
  }
  return picked
}

/** One line of the index: a name when the entry has one, otherwise the fact itself. */
export function indexLine(entry: MemoryEntry) {
  const fact = (entry.description || entry.body || '').replace(/\s+/g, ' ').trim()
  const day = DAY_PREFIX.exec(entry.name)?.[1]
  const named = !TRANSCRIPT_NAME.test(entry.name) && !day
  // A dated summary keeps its day: "when" is half of what makes a recent moment useful.
  const text = day ? `${day} · ${fact}` : named && fact ? `${entry.name}: ${fact}` : fact
  return text.length > INDEX_LINE_CHARS ? `${text.slice(0, INDEX_LINE_CHARS - 1)}…` : text
}

/**
 * The entries worth a line in the index, split by what they answer.
 *
 * Use when:
 * - Building the prompt index, which goes into every system prompt.
 *
 * Why three lists: measured on the running bank, one recency list carried 9 lines — five
 * evening summaries, three owner-profile lines and one stale mood label — while all 51
 * lore facts were invisible, because ingested prose rows arrive as `mem-<id>` and the old
 * rule dropped anything with that name. The birthday fact was in the bank the whole time.
 */
export function selectIndexEntries(entries: readonly MemoryEntry[], now = Date.now()) {
  const eligible = entries.filter((entry) => {
    if (!entry.description.trim())
      return false
    if (MOOD_LINE.test(entry.description) || MOOD_LINE.test(entry.name))
      return false
    return !isTranscriptEntry(entry)
  })

  const her: MemoryEntry[] = []
  const owner: MemoryEntry[] = []
  const recent: MemoryEntry[] = []
  for (const entry of eligible) {
    const text = `${entry.name} ${entry.description}`
    // A dated summary is a moment even when it mentions the owner; the owner section is for
    // what he is like, not for what happened on Tuesday.
    if (DAY_PREFIX.test(entry.name))
      recent.push(entry)
    else if (OWNER_LINE.test(text) && !HER_LINE.test(entry.description))
      owner.push(entry)
    else
      her.push(entry)
  }

  const distinct = (list: MemoryEntry[]) => {
    const kept: MemoryEntry[] = []
    for (const entry of [...list].sort((left, right) => indexScore(right, now) - indexScore(left, now))) {
      if (kept.every(other => similarity(other.description, entry.description) < 0.55))
        kept.push(entry)
    }
    return kept
  }

  const perDay = new Map<string, number>()
  const dated = recent
    .sort((left, right) => indexScore(right, now) - indexScore(left, now))
    .filter((entry) => {
      const day = DAY_PREFIX.exec(entry.name)?.[1]
      if (!day)
        return true
      const used = perDay.get(day) ?? 0
      if (used >= INDEX_PER_DAY)
        return false
      perDay.set(day, used + 1)
      return true
    })

  return {
    her: pickDiverse(distinct(her), INDEX_HER_LINES, now),
    owner: pickDiverse(distinct(owner), INDEX_OWNER_LINES, now),
    recent: dated.slice(0, INDEX_RECENT_LINES),
  }
}

/** The sectioned text that lands in the system prompt, inside the character budget. */
export function buildMemoryIndex(entries: readonly MemoryEntry[], now = Date.now()) {
  const { her, owner, recent } = selectIndexEntries(entries, now)
  const lines = (section: readonly MemoryEntry[]) => section.map(entry => `- ${indexLine(entry)}`)
  const sections: string[] = []
  let budget = INDEX_MAX_CHARS
  const add = (title: string, section: readonly MemoryEntry[]) => {
    const body = lines(section)
    if (!body.length)
      return
    const block = `${title}:\n${body.join('\n')}`
    if (block.length > budget)
      return
    budget -= block.length
    sections.push(block)
  }
  add('About you', her)
  add('About the owner', owner)
  add('Recent', recent)
  return sections.join('\n')
}

/**
 * Long-term memory as a small index and one entry per fact, kept by the character itself.
 *
 * Use when:
 * - A run reads the index or an entry, writes or forgets a fact, or Settings lists the memories by card.
 *
 * Expects:
 * - Callers pass the character card of the run. It reads its own memories and the general ones.
 * - Only the owner makes a memory general, in Settings. A run writes and forgets only its own card's memories.
 *
 * Returns:
 * - Whether memory is on, entries, the index for a card, and actions that change entries.
 */
/** Card id to bank persona, only where the two names are known to be one character. */
const PERSONA_ALIASES: Record<string, string> = { default: 'airi' }

export const useMemoryStore = defineStore('memory', () => {
  const enabled = useLocalStorageManualReset<boolean>('memory/enabled', true)
  const entries = useLocalStorageManualReset<MemoryEntry[]>('memory/entries', [])
  const castaliaMigrationComplete = useLocalStorageManualReset<boolean>('memory/castalia-migration-complete', false)

  /** True once a remote answered, so a host can show where memories live. */
  const remoteAttached = ref(false)
  let remote: MemoryRemotePort | undefined

  const sorted = computed(() => [...entries.value].sort((left, right) => left.name.localeCompare(right.name)))

  /**
   * Points the store at a durable backend.
   *
   * The local entries keep serving `indexFor`, `read`, and the tools without
   * waiting. This port only mirrors changes outward, and `hydrate` pulls the
   * remote state in once at start.
   */
  const remoteHealth = ref<MemoryRemoteHealth>({
    attached: false,
    okCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: '',
  })

  /** What the app reported about the backend on start; `undefined` until it answers. */
  const backend = ref<MemoryBackend | undefined>(undefined)

  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Re-reads the backend list soon, once.
   *
   * The cache is filled at start and by local writes only, so rows the backend creates on its own
   * (ingest, maintenance, self-cycle) stayed invisible to `read` and to the prompt index. Callers
   * that just caused such a row call this; the debounce keeps a burst of turns to one read.
   */
  function scheduleRefresh(delayMs = 2_000) {
    if (!remote || refreshTimer)
      return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void hydrate()
    }, delayMs)
  }

  /** Stores the backend report. The panel and the module list read this instead of guessing. */
  function setBackend(next: MemoryBackend | undefined) {
    backend.value = next
  }

  /**
   * One plain sentence about the backend, for a settings row.
   *
   * The memory capabilities can all be present while the emotion chain is not connected to the
   * engine: `recordEmotion` writes the panel and the prompt only, and the engine moves its psyche
   * from conversation only under `PSYCHE_FROM_VAD`. Saying "全部能力在线" in that state claimed a
   * capability the same sentence then denied, so the head names the gap instead.
   */
  function backendNote(): string | undefined {
    const current = backend.value
    if (!current)
      return undefined
    const missing = Object.entries(current.capabilities).filter(([, ok]) => !ok).map(([name]) => name)
    if (current.error)
      return current.error
    const truncation = current.entries?.truncated ? ` · 只读到 ${current.entries.listed} 条（撞上限，列表不是全部）` : ''
    if (!missing.length) {
      const emotionGap = Boolean(current.emotion && !current.emotion.autoFromVad)
      const head = emotionGap ? '记忆在线 · 情感链未接引擎' : '全部能力在线'
      const gate = emotionGap ? ` · ${current.emotion?.note}` : ''
      return `${current.transport} · ${current.project ?? '?'}/${current.character ?? '?'} · ${head}${gate}${truncation}`
    }
    return `${current.transport} · ${current.project ?? '?'}/${current.character ?? '?'} · 缺 ${missing.join('/')}`
  }

  function markRemoteOk() {
    remoteHealth.value = {
      ...remoteHealth.value,
      okCount: remoteHealth.value.okCount + 1,
      consecutiveFailures: 0,
      lastOkAt: Date.now(),
    }
  }

  function markRemoteFailure(cause: unknown) {
    remoteHealth.value = {
      ...remoteHealth.value,
      failureCount: remoteHealth.value.failureCount + 1,
      consecutiveFailures: remoteHealth.value.consecutiveFailures + 1,
      lastErrorAt: Date.now(),
      lastError: String((cause as { message?: string } | undefined)?.message ?? cause),
    }
  }

  /** One readable line for a tool answer: the backend's own message when it has one. */
  function errorText(cause: unknown) {
    const message = (cause as { message?: string } | undefined)?.message
    const text = String(message ?? cause ?? 'unknown error').trim()
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }

  function attachRemote(port: MemoryRemotePort | undefined) {
    remote = port
    remoteAttached.value = Boolean(port)
    remoteHealth.value = { ...remoteHealth.value, attached: Boolean(port) }
  }

  /** Replaces the local cache with the remote state. Keeps the cache when the remote fails. */
  async function hydrate(): Promise<boolean> {
    if (!remote)
      return false
    try {
      const localEntries = entries.value
      const durableEntries = await remote.list()
      if (castaliaMigrationComplete.value) {
        entries.value = durableEntries
      }
      else {
        const merged = new Map(durableEntries.map(entry => [`${entry.name}\u0000${entry.persona ?? ''}`, entry]))
        for (const entry of localEntries) {
          const key = `${entry.name}\u0000${entry.persona ?? ''}`
          const durable = merged.get(key)
          if (!durable || entry.updatedAt > durable.updatedAt) {
            merged.set(key, entry)
            await remote.save(entry)
          }
        }
        entries.value = [...merged.values()]
        castaliaMigrationComplete.value = true
      }
      markRemoteOk()
      return true
    }
    catch (cause) {
      console.warn('[memory] remote hydrate failed, keeping local entries:', cause)
      markRemoteFailure(cause)
      return false
    }
  }

  /** General memories and the persona's own. */
  function visibleTo(personaId: string) {
    return sorted.value.filter(entry => !entry.persona || entry.persona === personaId)
  }

  /**
   * The persona whose memories this card should read.
   *
   * A card id and the bank's character id are two names for one character, and only a known alias may join them:
   * the built-in card is `default` while its rows are `airi`. Every other card is a character of her own.
   *
   * This used to fall back to "the bank holds exactly one persona", which quietly merged every card into that one
   * character: a second card read the first one's facts, and worse, wrote her moods into the same state. Sharing a
   * bank is not sharing a self.
   */
  /**
   * 卡 → 记忆里的角色 id。
   *
   * 键就是卡的 id：卡 id 是 `N_h4lzz…`（尤诺那张卡），行就写在这个 id 下。`airi` 是卡内容里的
   * 角色自我介绍，不是分区键——别按角色名猜分区。
   *
   * 别名只在两种情况下生效：本地缓存里已经有这个别名下的行（历史数据），否则一律用卡自己的 id。
   * 不能退到"后端上报的 character"：那是**当前**写入方的 id，切到别的卡时会让两张卡共用一份记忆。
   */
  function resolvePersona(personaId: string) {
    if (sorted.value.some(entry => entry.persona === personaId))
      return personaId

    const alias = PERSONA_ALIASES[personaId]
    if (alias && sorted.value.some(entry => entry.persona === alias))
      return alias

    return personaId
  }

  /**
   * The index for a card: her own facts, facts about the owner, then the last few moments.
   *
   * A card reads its own entries plus the general ones. Sections are content, not scope:
   * `read`/`write` permission stays with the card, and the prompt says so.
   */
  function indexFor(personaId: string) {
    const ownId = resolvePersona(personaId)
    // The card's own entry shadows a general one with the same name, as `read` does.
    const visible = visibleTo(ownId)
    const ownNames = new Set(visible.filter(entry => entry.persona === ownId).map(entry => memoryName(entry.name)))
    const unique = visible.filter(entry => entry.persona === ownId || !ownNames.has(memoryName(entry.name)))
    return buildMemoryIndex(unique, Date.now())
  }

  /** Reads an entry by name. The persona's own entry wins over a general one with the same name. */
  function read(name: string, personaId: string) {
    const key = memoryName(name)
    // Hydrated rows keep the heading they were written with ("Reference: 小托…"), so a
    // normalized lookup has to normalize both sides or every read misses.
    // The index also truncates long headings with `…`; the model copies that line, so a
    // visible prefix has to resolve to the row it came from.
    const matches = visibleTo(personaId).filter((entry) => {
      const stored = memoryName(entry.name)
      return stored === key || (key.length >= 8 && stored.startsWith(key))
    })
    return matches.find(entry => entry.persona === personaId) ?? matches[0]
  }

  /**
   * Creates or replaces an entry of the card by name.
   *
   * The local cache updates at once (a UI edit must not wait on a slow backend), and `persisted`
   * reports what the backend did. A refusal rolls the cache back, so the list never shows a
   * deletion or an edit the durable store did not accept.
   */
  function write(entry: Pick<MemoryEntry, 'name' | 'description' | 'body'>, personaId: string): MemoryWriteResult {
    const name = memoryName(entry.name)
    if (!name || !entry.body.trim())
      return { persisted: Promise.resolve({ ok: false, reason: 'invalid' }) }
    const next: MemoryEntry = { name, description: entry.description.trim(), body: entry.body.trim(), persona: personaId, updatedAt: Date.now() }
    const shadowed = entries.value.filter(existing => memoryName(existing.name) === name && existing.persona === personaId)
    entries.value = [...entries.value.filter(existing => memoryName(existing.name) !== name || existing.persona !== personaId), next]
    const persisted = (async (): Promise<MemoryPersistResult> => {
      if (!remote)
        return { ok: true }
      try {
        await remote.save(next)
        markRemoteOk()
        return { ok: true }
      }
      catch (cause) {
        console.warn('[memory] remote save failed:', cause)
        markRemoteFailure(cause)
        entries.value = [...entries.value.filter(existing => existing !== next), ...shadowed]
        return { ok: false, reason: 'failed', error: errorText(cause) }
      }
    })()
    return { entry: next, persisted }
  }

  /** Makes a card's memory general, so every card reads it. A general memory with the same name gives way. */
  /**
   * Moves one entry from a card to the shared set.
   *
   * The move is two backend calls. The page used to flip the local row first, so a refused delete
   * or a failed save left something that looked shared until the next hydrate (audit A08). The
   * backend goes first now, and the local list changes only after both steps land.
   *
   * The delete carries the row id: derived `mem-*` rows have no store name, so a name lookup cannot
   * find them.
   */
  async function makeGeneral(entry: Pick<MemoryEntry, 'id' | 'name' | 'persona'>): Promise<{ ok: boolean, error?: string }> {
    const source = entries.value.find(existing =>
      existing.name === entry.name
      && existing.persona === entry.persona
      && (entry.id === undefined || existing.id === entry.id))
    if (!source?.persona)
      return { ok: false, error: 'only a memory that belongs to a card can become general' }
    const { persona: _card, ...general } = source
    const moved: MemoryEntry = { ...general, updatedAt: Date.now() }
    if (remote) {
      try {
        const gone = await remote.forget({ id: source.id, name: source.name, persona: source.persona })
        if (!gone)
          return { ok: false, error: 'the backend kept the original entry' }
        await remote.save(moved)
        markRemoteOk()
      }
      catch (cause) {
        console.warn('[memory] make-general failed:', cause)
        markRemoteFailure(cause)
        return { ok: false, error: errorText(cause) }
      }
    }
    entries.value = [
      ...entries.value.filter(existing => existing !== source && (existing.name !== source.name || existing.persona)),
      moved,
    ]
    return { ok: true }
  }

  /** Removes one entry, from a tool or from Settings. The backend's answer decides whether it stays gone. */
  function remove(entry: Pick<MemoryEntry, 'id' | 'name' | 'persona'>): MemoryForgetResult {
    const removed = entries.value.filter(existing => existing.name === entry.name && existing.persona === entry.persona)
    if (!removed.length)
      return { found: false, persisted: Promise.resolve({ ok: false, reason: 'refused', error: 'no such entry' }) }
    entries.value = entries.value.filter(existing => existing.name !== entry.name || existing.persona !== entry.persona)
    const persisted = (async (): Promise<MemoryPersistResult> => {
      if (!remote)
        return { ok: true }
      try {
        const gone = await remote.forget({ id: entry.id, name: entry.name, persona: entry.persona })
        // A `false` is a refusal, not a no-op: the backend keeps the row (shared entry, derived
        // diary, other persona). Restoring the rows keeps the list honest about that.
        if (gone === false) {
          entries.value = [...entries.value, ...removed]
          return { ok: false, reason: 'refused', error: 'the backend kept the entry' }
        }
        markRemoteOk()
        return { ok: true }
      }
      catch (cause) {
        console.warn('[memory] remote forget failed:', cause)
        markRemoteFailure(cause)
        entries.value = [...entries.value, ...removed]
        return { ok: false, reason: 'failed', error: errorText(cause) }
      }
    })()
    return { found: true, persisted }
  }

  /** Forgets an entry of the card by name. General memories belong to the owner, so a run cannot forget them. */
  function forget(name: string, personaId: string): MemoryForgetResult {
    const key = memoryName(name)
    const target = entries.value.find(entry => memoryName(entry.name) === key && entry.persona === personaId)
    if (!target)
      return { found: false, persisted: Promise.resolve({ ok: false, reason: 'refused', error: 'no such entry' }) }
    return remove(target)
  }

  /**
   * Recalls memories for one turn as a ready-to-inject block.
   *
   * Answers empty when memory is off, no port can recall, or nothing passed the
   * backend's gate. A failed recall never reaches the caller: a turn without the
   * block reads better than a turn that reports a backend error.
   */
  async function recallForInjection(query: string, persona?: string): Promise<string> {
    if (!enabled.value || !remote?.recall)
      return ''
    const text = query.trim()
    if (!text)
      return ''
    try {
      const recalled = (await remote.recall(text, persona)).text
      markRemoteOk()
      return recalled
    }
    catch (cause) {
      console.warn('[memory] remote recall failed:', cause)
      markRemoteFailure(cause)
      return ''
    }
  }

  /**
   * Ranked lookup for a tool call: the rows plus the near facts, and how the lookup itself ended.
   *
   * `unavailable` (no search port) and `failed` (the port threw) stay distinguishable from `ok`
   * with no hits. The tool says "nothing matched" only in the last case, because an unreachable
   * backend is not evidence that a fact is absent — that sentence was the bug the audit found.
   */
  async function lookup(query: string, topK = 5, persona?: string): Promise<MemoryLookup> {
    const text = query.trim()
    if (!enabled.value)
      return { status: 'unavailable', hits: [], facts: [], error: 'memory is off' }
    if (!text)
      return { status: 'ok', hits: [], facts: [] }
    if (!remote?.search)
      return { status: 'unavailable', hits: [], facts: [], error: 'no search backend attached' }
    // A backend that reports no search still answers `[]`, which reads as "nothing matched" and
    // even counts as a healthy call. Ask the capability first (audit A04).
    const caps = backend.value?.capabilities
    if (caps && !caps.search)
      return { status: 'unavailable', hits: [], facts: [], error: 'this backend cannot search: entry-only mode' }
    const [rows, facts] = await Promise.allSettled([
      remote.search(text, topK, persona),
      remote.facts ? remote.facts(text, FACT_TOP_K, persona) : Promise.resolve([] as MemoryFact[]),
    ])
    if (rows.status === 'rejected') {
      console.warn('[memory] remote search failed:', rows.reason)
      markRemoteFailure(rows.reason)
      // Two ports that both failed are two unhealthy endpoints, not one: counting both is what
      // moves the store to `remoteDegraded` (two consecutive failures) instead of hiding it.
      if (facts.status === 'rejected')
        markRemoteFailure(facts.reason)
      return { status: 'failed', hits: [], facts: [], error: errorText(rows.reason) }
    }
    const hits = (Array.isArray(rows.value) ? rows.value : []).filter(hit => typeof hit?.text === 'string' && hit.text.trim())
    if (facts.status === 'rejected') {
      console.warn('[memory] remote fact search failed:', facts.reason)
      markRemoteFailure(facts.reason)
      return { status: 'partial', hits, facts: [], error: `fact lookup failed: ${errorText(facts.reason)}` }
    }
    markRemoteOk()
    // Facts close enough to be worth printing (cosine 0.6, measured on the real bank: "小托"
    // reaches 0.73 while an unrelated query like "生日" tops out at 0.51 and stays out).
    const near = (Array.isArray(facts.value) ? facts.value : [])
      .filter(fact => fact?.object && (fact.similarity ?? 1) >= 0.6)
      .slice(0, FACT_TOP_K)
    return { status: 'ok', hits, facts: near }
  }

  /**
   * Records the turn that just finished: what the user said, what she answered.
   *
   * This is the only path that keeps a conversation the model did not explicitly
   * save. It runs after the reply is already shown, so a failure only reaches the
   * console; the turn stays unsaved rather than the reply breaking.
   */
  async function ingestTurn(turn: MemoryIngestTurn): Promise<MemoryIngestResult> {
    if (!enabled.value || !remote?.ingest)
      return { ok: false, error: 'memory disabled or backend cannot ingest' }
    const user = turn.user.trim()
    const assistant = turn.assistant.trim()
    if (!user || !assistant)
      return { ok: false, error: 'empty turn' }
    try {
      const result = await remote.ingest({ user, assistant, ...(turn.sessionId ? { sessionId: turn.sessionId } : {}), ...(turn.persona ? { persona: turn.persona } : {}) })
      if (result.ok) {
        markRemoteOk()
        // The turn the backend just wrote is not in the local cache, so `read` and the prompt
        // index stayed blind to it until a restart (audit F09). One debounced re-read fixes that.
        scheduleRefresh()
      }
      else {
        markRemoteFailure(result.error ?? 'ingest rejected')
      }
      return result
    }
    catch (cause) {
      console.warn('[memory] remote ingest failed:', cause)
      markRemoteFailure(cause)
      return { ok: false, error: String(cause) }
    }
  }

  function resetState() {
    enabled.reset()
    entries.reset()
    castaliaMigrationComplete.reset()
  }

  /**
   * The backend stopped answering while its port stays attached. Two failures in a row is the
   * threshold: one dropped call can be a restart, a run of them is a dead engine.
   */
  const remoteDegraded = computed(() => remoteHealth.value.attached && remoteHealth.value.consecutiveFailures >= 2)

  return {
    enabled,
    entries: sorted,
    backend,
    setBackend,
    scheduleRefresh,
    backendNote,
    remoteAttached,
    remoteHealth,
    remoteDegraded,
    attachRemote,
    hydrate,
    visibleTo,
    resolvePersona,
    indexFor,
    read,
    lookup,
    write,
    makeGeneral,
    forget,
    remove,
    recallForInjection,
    ingestTurn,
    resetState,
  }
})
