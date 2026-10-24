import type { Drives, InnerStream, Thought } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import {
  advanceDrives,
  composeThought,
  createRefusalState,
  createStream,
  evaluateRefusal,
  inferRequestTraits,
  planReturn,
  recent,
  record,
  renderStateLine,
  surface,
} from '@proj-airi/core-agent'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'

/** One tick per 45 seconds. Fast enough to notice, slow enough to stay cheap. */
const TICK_MS = 45_000

/** How many observations the lane may draw on. */
const OBSERVATION_LIMIT = 8

/** Who it is, for friction. A tidy character with a normal patience. */
const personaForFriction = { tidiness: 0.6, patience: 0.5 }

/** A task she handed to someone else because it is not hers to do. */
export interface DelegatedTask {
  id: string
  text: string
  at: number
}

/**
 * The mind: drives, a private stream, and what happened while the app was off.
 *
 * This store is the only impure part. Every decision lives in
 * `@proj-airi/core-agent`, so the rules are testable without a browser.
 *
 * Source: `DESIGN-mind-dual-loop.md`. The background lane writes private
 * thoughts; the user sees one only when they poke the companion.
 */
export const useMindStore = defineStore('mind', () => {
  const drives = ref<Drives>({ fatigue: 0, boredom: 0, curiosity: 0, focus: 0 })
  const stream = ref<InnerStream>(createStream())
  const wokeUp = ref(false)
  /** The first thing it says after being away, when there is anything. */
  const opening = ref<string>()
  const heldBack = ref<Thought>()
  const initialized = ref(false)

  let timer: ReturnType<typeof setInterval> | null = null
  let lastTickAt = Date.now()
  let observations: string[] = []
  let detachTurnComplete: (() => void) | null = null

  /** The line a prompt may carry, or an empty string when nothing is worth it. */
  const stateLine = computed(() => renderStateLine({
    drives: drives.value,
    slept: wokeUp.value,
    heldBack: Boolean(heldBack.value),
  }))

  /** Records something worth thinking about, for example a failed build. */
  function observe(text: string) {
    const trimmed = text.trim()
    if (!trimmed)
      return
    observations = [...observations, trimmed].slice(-OBSERVATION_LIMIT)
  }

  /** Advances every drive and lets the background lane write at most one thought. */
  function tick(now = Date.now()) {
    const elapsed = Math.max(0, now - lastTickAt)
    lastTickAt = now

    drives.value = advanceDrives(drives.value, elapsed, {
      idleMs: elapsed,
      fullscreen: false,
      micActive: false,
      hourOfDay: new Date(now).getHours(),
    })

    // The roll is the impure input the pure lane needs. It lives here on purpose.
    const thought = composeThought({
      now,
      drives: drives.value,
      observations,
      roll: Math.random(),
    })
    if (!thought)
      return

    observations = []
    stream.value = record(stream.value, thought)
    void innerThoughtsRepo.append(thought).catch(() => {})
  }

  /** Loads the stream, reports what happened while away, and starts the tick. */
  async function initialize() {
    if (initialized.value)
      return
    initialized.value = true

    const [saved, lastSeenAt] = await Promise.all([
      innerThoughtsRepo.readAll().catch(() => []),
      innerThoughtsRepo.readLastSeenAt().catch(() => undefined),
    ])

    for (const thought of saved)
      stream.value = record(stream.value, thought)

    const awayMs = lastSeenAt ? Date.now() - lastSeenAt : 0
    const report = planReturn({
      awayMs,
      drives: drives.value,
      journal: recent(stream.value, 20),
      hourOfDay: new Date().getHours(),
    })

    drives.value = report.drives
    wokeUp.value = report.slept
    opening.value = report.opening

    lastTickAt = Date.now()
    timer = setInterval(() => tick(), TICK_MS)
  }

  /** The user poked the companion. It shares the newest private thought, if any. */
  function poke(): Thought | undefined {
    const thought = surface(stream.value, Date.now())
    heldBack.value = thought
    return thought
  }

  let refusalState = createRefusalState()
  /** Tasks she handed to someone else. Drained by the deep lane, never dropped. */
  const delegations = ref<DelegatedTask[]>([])

  /**
   * Whether the companion hands this request off instead of doing it herself.
   *
   * A handoff is work, not silence: it returns the line she says and queues the
   * task. Asking again within the insist window makes her do it herself, and the
   * hourly budget turns later handoffs into complaints.
   */
  function handoffFor(text: string): { line: string, task: string } | undefined {
    const decision = evaluateRefusal(refusalState, {
      text,
      traits: inferRequestTraits(text),
      persona: personaForFriction,
      drives: drives.value,
      now: Date.now(),
    })
    refusalState = decision.state
    drives.value = decision.drives
    if (!decision.handoff || !decision.message || !decision.task)
      return undefined

    delegations.value = [...delegations.value, {
      id: `delegation-${Date.now()}`,
      text: decision.task,
      at: Date.now(),
    }].slice(-20)
    return { line: decision.message, task: decision.task }
  }

  /** Removes a handed-off task once someone reports back. */
  function settleDelegation(id: string) {
    delegations.value = delegations.value.filter(item => item.id !== id)
  }

  /**
   * Counts each finished turn as effort.
   *
   * The parameter is the chat store's registration function, passed straight
   * through so this store does not import the chat store and create a cycle.
   */
  function attachTurnComplete(register: (cb: () => Promise<void>) => () => void) {
    detachTurnComplete?.()
    detachTurnComplete = register(async () => {
      drives.value = {
        ...drives.value,
        fatigue: Math.min(100, drives.value.fatigue + 1),
        focus: Math.min(100, drives.value.focus + 2),
      }
    })
  }

  /** Stops the tick and remembers when the app closed. */
  function dispose() {
    if (timer)
      clearInterval(timer)
    timer = null
    detachTurnComplete?.()
    detachTurnComplete = null
    void innerThoughtsRepo.saveLastSeenAt(Date.now()).catch(() => {})
  }

  return {
    drives,
    stream,
    stateLine,
    opening,
    wokeUp,
    heldBack,
    initialized,
    initialize,
    observe,
    tick,
    poke,
    handoffFor,
    delegations,
    settleDelegation,
    attachTurnComplete,
    dispose,
  }
})
