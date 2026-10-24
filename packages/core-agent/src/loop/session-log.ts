/**
 * A turn record that can be replayed.
 *
 * The loop is a pure state machine, so the events it consumed are enough to
 * reproduce every effect it produced. Recording that pair per step gives a log
 * without changing the loop's decisions.
 *
 * NOTICE:
 * This is a per-turn log, not a session log.
 * DeepSeek Harness keeps one append-only session log per session and derives
 * model messages from it (`@deepseek-ai/dsh-session`). AIRI stores messages
 * directly and has no log, so a full session log would mean rewriting
 * `stores/chat/session-store.ts`, which is in the frozen zone.
 * Keeping the log scoped to one turn is the part that fits today.
 * Replace this module when the session layer can own the log; the `step`
 * contract and the tests here carry over unchanged.
 */
import type { LoopEffect, LoopEvent, LoopPolicy, LoopState } from './turn-loop'

import { createState, defaultLoopPolicy, step } from './turn-loop'

/** One decision the loop made and the effects that followed. */
export interface StepRecord {
  event: LoopEvent
  effects: LoopEffect[]
}

/** Newline-delimited JSON, one step per line. Append friendly. */
export function serializeRecord(records: StepRecord[]): string {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}

export function parseRecord(text: string): StepRecord[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Partial<StepRecord>
      if (!parsed || typeof parsed !== 'object' || !parsed.event)
        throw new Error('Not a step record')
      return { event: parsed.event, effects: parsed.effects ?? [] }
    })
}

export interface ReplayResult {
  state: LoopState
  /** True when every recorded effect reappears in the same order. */
  matches: boolean
  /** The first step whose effects differ from the record. */
  divergedAt?: number
}

/**
 * Replays the recorded events through the same state machine.
 *
 * Equality is structural on the effects, which is why `step` must stay pure and
 * deterministic. A clock, a random value, or a store read inside `step` would
 * break this test, and that is the point.
 */
export function replay(
  records: StepRecord[],
  policy: LoopPolicy = defaultLoopPolicy,
): ReplayResult {
  let state = createState()

  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const next = step(state, record.event, policy)
    const expected = JSON.stringify(record.effects)
    const actual = JSON.stringify(next.effects)
    if (expected !== actual)
      return { state: next.state, matches: false, divergedAt: index }
    state = next.state
  }

  return { state, matches: true }
}
