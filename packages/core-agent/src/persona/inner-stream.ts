/**
 * The private stream of thought.
 *
 * A companion that says everything it thinks has no inner life. This keeps
 * every thought, but only a few ever reach the user, and only when the user
 * asks. The rest stay in the stream and inform later behavior.
 *
 * Source: Generative Agents (Park et al., UIST 2023) calls the same idea a
 * memory stream with reflection. Oz Project (Bates, 1992) calls the result a
 * believable agent. Neither ships code for the privacy rule, so it lives here.
 */

export type ThoughtVisibility = 'private' | 'shared'

export interface Thought {
  id: string
  /** Wall-clock time of the thought. */
  at: number
  text: string
  /** `private` never reaches the user unless they ask. */
  visibility: ThoughtVisibility
  /** A short label, so a later recall can find related thoughts. */
  topic?: string
  /**
   * The character this thought belongs to.
   *
   * One stream serves every card, and a diary is the most private thing a character has. A thought without a
   * persona predates the split and is claimed by the first character that reads the diary.
   */
  persona?: string
}

export interface InnerStream {
  entries: Thought[]
  /** Oldest entries are dropped past this count. */
  maxEntries: number
}

export function createStream(maxEntries = 200): InnerStream {
  return { entries: [], maxEntries }
}

/** Appends a thought and drops the oldest entries past the cap. */
export function record(stream: InnerStream, thought: Thought): InnerStream {
  const entries = [...stream.entries, thought]
  const overflow = Math.max(0, entries.length - stream.maxEntries)
  return { ...stream, entries: overflow > 0 ? entries.slice(overflow) : entries }
}

/**
 * Marks one thought as said out loud.
 *
 * A thought is private until she repeats it in a delivered line. Nothing else may change its
 * visibility, so the diary's "said out loud" column has exactly one producer.
 *
 * Returns the same stream when the id is unknown or the thought is already shared.
 */
export function markShared(stream: InnerStream, id: string): InnerStream {
  const index = stream.entries.findIndex(entry => entry.id === id)
  if (index < 0 || stream.entries[index].visibility === 'shared')
    return stream
  const entries = stream.entries.slice()
  entries[index] = { ...entries[index], visibility: 'shared' }
  return { ...stream, entries }
}

export function recent(stream: InnerStream, count: number): Thought[] {
  return stream.entries.slice(-Math.max(0, count))
}

/**
 * Returns the newest private thought old enough to be worth surfacing.
 *
 * Called when the user pokes the companion, never on a timer. A thought from
 * one second ago is still being had, so it waits for `minAgeMs`.
 */
export function surface(
  stream: InnerStream,
  now: number,
  minAgeMs = 30_000,
): Thought | undefined {
  for (let i = stream.entries.length - 1; i >= 0; i--) {
    const entry = stream.entries[i]
    if (entry.visibility !== 'private')
      continue
    if (now - entry.at < minAgeMs)
      continue
    return entry
  }
  return undefined
}

/** The share of thoughts that ever reach the user. */
export function sharedRatio(stream: InnerStream): number {
  if (stream.entries.length === 0)
    return 0
  const shared = stream.entries.filter(entry => entry.visibility === 'shared').length
  return shared / stream.entries.length
}
