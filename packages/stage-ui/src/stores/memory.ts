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

export interface MemoryRemotePort { /** Every entry the remote holds. Replaces the local cache on start. */
  list: () => Promise<MemoryEntry[]>
  save: (entry: MemoryEntry) => Promise<void>
  forget: (entry: Pick<MemoryEntry, 'id' | 'name' | 'persona'>) => Promise<void>
  /**
   * Renders a context block for one query, from the entries the backend ranks.
   *
   * A port without it leaves the recall provider with nothing to inject. The
   * recall reads ranked text, so it never serves the synchronous prompt index.
   */
  recall?: (query: string) => Promise<MemoryRecall>
  /**
   * Ranked lookup over the whole bank for one query.
   *
   * Different from `recall`: no injection block, no similarity gate, no character
   * budget — it answers "what does memory hold about this" for a tool call, so an
   * empty array means "nothing matched", not "nothing worth injecting".
   */
  search?: (query: string, topK?: number) => Promise<MemorySearchHit[]>
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
  const named = !TRANSCRIPT_NAME.test(entry.name) && !/^\d{4}-\d{2}-\d{2}\s*·/.test(entry.name)
  const text = named && fact ? `${entry.name}: ${fact}` : fact
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
   * A card id and the character id of the memory bank are two different names for the same character, and they
   * do not always match: the built-in card is `default` while its bank rows are `airi`. When the requested id owns
   * no entry and the bank holds exactly one persona, that persona is this character — reading it beats showing an
   * empty index to the model while 17 KB of memories sit one name away.
   */
  function resolvePersona(personaId: string) {
    if (sorted.value.some(entry => entry.persona === personaId))
      return personaId

    const personas = new Set(sorted.value.map(entry => entry.persona).filter(Boolean) as string[])
    return personas.size === 1 ? [...personas][0]! : personaId
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
    const visible = visibleTo(personaId)
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

  /** Creates or replaces an entry of the card by name. Returns the stored entry, or undefined for an empty name or body. */
  function write(entry: Pick<MemoryEntry, 'name' | 'description' | 'body'>, personaId: string) {
    const name = memoryName(entry.name)
    if (!name || !entry.body.trim())
      return undefined
    const next: MemoryEntry = { name, description: entry.description.trim(), body: entry.body.trim(), persona: personaId, updatedAt: Date.now() }
    entries.value = [...entries.value.filter(existing => memoryName(existing.name) !== name || existing.persona !== personaId), next]
    void remote?.save(next).catch((cause) => {
      console.warn('[memory] remote save failed:', cause)
      markRemoteFailure(cause)
    })
    return next
  }

  /** Makes a card's memory general, so every card reads it. A general memory with the same name gives way. */
  function makeGeneral(entry: Pick<MemoryEntry, 'name' | 'persona'>) {
    const source = entries.value.find(existing => existing.name === entry.name && existing.persona === entry.persona)
    if (!source?.persona)
      return
    const { persona: _card, ...general } = source
    const moved: MemoryEntry = { ...general, updatedAt: Date.now() }
    entries.value = [...entries.value.filter(existing => existing !== source && (existing.name !== source.name || existing.persona)), moved]
    if (remote) {
      void remote.forget({ name: source.name, persona: source.persona }).catch((cause) => {
        console.warn('[memory] remote forget failed:', cause)
        markRemoteFailure(cause)
      })
      void remote.save(moved).catch((cause) => {
        console.warn('[memory] remote save failed:', cause)
        markRemoteFailure(cause)
      })
    }
  }

  /** Removes one entry, from a tool or from Settings. */
  function remove(entry: Pick<MemoryEntry, 'id' | 'name' | 'persona'>) {
    entries.value = entries.value.filter(existing => existing.name !== entry.name || existing.persona !== entry.persona)
    void remote?.forget({ id: entry.id, name: entry.name, persona: entry.persona }).catch((cause) => {
      console.warn('[memory] remote forget failed:', cause)
      markRemoteFailure(cause)
    })
  }

  /** Forgets an entry of the card by name. General memories belong to the owner, so a run cannot forget them. */
  function forget(name: string, personaId: string) {
    const key = memoryName(name)
    const target = entries.value.find(entry => memoryName(entry.name) === key && entry.persona === personaId)
    if (!target)
      return false
    remove(target)
    return true
  }

  /**
   * Recalls memories for one turn as a ready-to-inject block.
   *
   * Answers empty when memory is off, no port can recall, or nothing passed the
   * backend's gate. A failed recall never reaches the caller: a turn without the
   * block reads better than a turn that reports a backend error.
   */
  async function recallForInjection(query: string): Promise<string> {
    if (!enabled.value || !remote?.recall)
      return ''
    const text = query.trim()
    if (!text)
      return ''
    try {
      const recalled = (await remote.recall(text)).text
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
   * Ranked lookup for a tool call.
   *
   * Answers `[]` when memory is off, the backend has no search, the call fails, or
   * nothing matched. The tool reports an empty list to the model as "nothing found",
   * which is why a failure is logged and counted but never thrown.
   */
  async function search(query: string, topK = 5): Promise<MemorySearchHit[]> {
    if (!enabled.value || !remote?.search)
      return []
    const text = query.trim()
    if (!text)
      return []
    try {
      const hits = await remote.search(text, topK)
      markRemoteOk()
      return Array.isArray(hits) ? hits.filter(hit => typeof hit?.text === 'string' && hit.text.trim()) : []
    }
    catch (cause) {
      console.warn('[memory] remote search failed:', cause)
      markRemoteFailure(cause)
      return []
    }
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
      const result = await remote.ingest({ user, assistant, ...(turn.sessionId ? { sessionId: turn.sessionId } : {}) })
      if (result.ok)
        markRemoteOk()
      else
        markRemoteFailure(result.error ?? 'ingest rejected')
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
    remoteAttached,
    remoteHealth,
    remoteDegraded,
    attachRemote,
    hydrate,
    visibleTo,
    resolvePersona,
    indexFor,
    read,
    search,
    write,
    makeGeneral,
    forget,
    remove,
    recallForInjection,
    ingestTurn,
    resetState,
  }
})
