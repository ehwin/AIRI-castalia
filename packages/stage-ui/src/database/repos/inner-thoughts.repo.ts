import type { Thought } from '@proj-airi/core-agent'

import localforage from 'localforage'

const thoughts = localforage.createInstance({ name: 'airi-mind', storeName: 'thoughts' })
const meta = localforage.createInstance({ name: 'airi-mind', storeName: 'meta' })

const LAST_SEEN_KEY = 'lastSeenAt'

/**
 * The inner stream on disk.
 *
 * Private thoughts outlive a restart. A companion that forgets what it was
 * thinking about five minutes ago has no continuity, and continuity is most of
 * what makes it feel present.
 *
 * Source: Generative Agents (Park et al., UIST 2023) keeps the memory stream
 * across runs the same way. The store is local and small; no sync.
 */
export const innerThoughtsRepo = {
  /** Returns the newest thoughts, oldest first. */
  async readAll(limit = 200): Promise<Thought[]> {
    const records: Thought[] = []
    await thoughts.iterate<Thought, void>((entry) => { records.push(entry) })
    records.sort((a, b) => a.at - b.at)
    return records.slice(-limit)
  },

  async append(thought: Thought): Promise<void> {
    await thoughts.setItem(thought.id, thought)
  },

  /** When the companion last ran, so a restart can compute how long it was away. */
  async readLastSeenAt(): Promise<number | undefined> {
    const value = await meta.getItem<number>(LAST_SEEN_KEY)
    return typeof value === 'number' ? value : undefined
  },

  async saveLastSeenAt(at: number): Promise<void> {
    await meta.setItem(LAST_SEEN_KEY, at)
  },

  async clear(): Promise<void> {
    await thoughts.clear()
    await meta.removeItem(LAST_SEEN_KEY)
  },
}
