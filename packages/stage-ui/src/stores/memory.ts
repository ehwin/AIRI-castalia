import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** One remembered fact. A character keeps it on its own card. A general memory reaches every card. */
export interface MemoryEntry {
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
export interface MemoryRemotePort {
  /** Every entry the remote holds. Replaces the local cache on start. */
  list: () => Promise<MemoryEntry[]>
  save: (entry: MemoryEntry) => Promise<void>
  forget: (entry: Pick<MemoryEntry, 'name' | 'persona'>) => Promise<void>
}

/** Turns a free name into the kebab-case key that entries use. */
export function memoryName(name: string) {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
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
  function attachRemote(port: MemoryRemotePort | undefined) {
    remote = port
    remoteAttached.value = Boolean(port)
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
      return true
    }
    catch (cause) {
      console.warn('[memory] remote hydrate failed, keeping local entries:', cause)
      return false
    }
  }

  /** General memories and the persona's own. */
  function visibleTo(personaId: string) {
    return sorted.value.filter(entry => !entry.persona || entry.persona === personaId)
  }

  /** The index for a card: its own memories, then general ones, each as a name and its description. */
  function indexFor(personaId: string) {
    const line = (entry: MemoryEntry) => `- ${entry.name}: ${entry.description}`
    const byName = (left: MemoryEntry, right: MemoryEntry) => left.name.localeCompare(right.name)
    const own = sorted.value.filter(entry => entry.persona === personaId).sort(byName).map(line)
    const general = sorted.value.filter(entry => !entry.persona).sort(byName).map(line)
    return [
      ...(own.length ? [`Your own:\n${own.join('\n')}`] : []),
      ...(general.length ? [`General:\n${general.join('\n')}`] : []),
    ].join('\n')
  }

  /** Reads an entry by name. The persona's own entry wins over a general one with the same name. */
  function read(name: string, personaId: string) {
    const key = memoryName(name)
    const matches = visibleTo(personaId).filter(entry => entry.name === key)
    return matches.find(entry => entry.persona === personaId) ?? matches[0]
  }

  /** Creates or replaces an entry of the card by name. Returns the stored entry, or undefined for an empty name or body. */
  function write(entry: Pick<MemoryEntry, 'name' | 'description' | 'body'>, personaId: string) {
    const name = memoryName(entry.name)
    if (!name || !entry.body.trim())
      return undefined
    const next: MemoryEntry = { name, description: entry.description.trim(), body: entry.body.trim(), persona: personaId, updatedAt: Date.now() }
    entries.value = [...entries.value.filter(existing => existing.name !== name || existing.persona !== personaId), next]
    void remote?.save(next).catch((cause) => {
      console.warn('[memory] remote save failed:', cause)
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
      })
      void remote.save(moved).catch((cause) => {
        console.warn('[memory] remote save failed:', cause)
      })
    }
  }

  /** Removes one entry, from a tool or from Settings. */
  function remove(entry: Pick<MemoryEntry, 'name' | 'persona'>) {
    entries.value = entries.value.filter(existing => existing.name !== entry.name || existing.persona !== entry.persona)
    void remote?.forget({ name: entry.name, persona: entry.persona }).catch((cause) => {
      console.warn('[memory] remote forget failed:', cause)
    })
  }

  /** Forgets an entry of the card by name. General memories belong to the owner, so a run cannot forget them. */
  function forget(name: string, personaId: string) {
    const key = memoryName(name)
    const target = entries.value.find(entry => entry.name === key && entry.persona === personaId)
    if (!target)
      return false
    remove(target)
    return true
  }

  function resetState() {
    enabled.reset()
    entries.reset()
    castaliaMigrationComplete.reset()
  }

  return {
    enabled,
    entries: sorted,
    remoteAttached,
    attachRemote,
    hydrate,
    visibleTo,
    indexFor,
    read,
    write,
    makeGeneral,
    forget,
    remove,
    resetState,
  }
})
