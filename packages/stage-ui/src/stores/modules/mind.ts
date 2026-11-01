import type { Drives, InnerStream, SensePort, Thought } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import {
  advanceDrives,
  blindSense,
  composeInnerVoice,
  composeThought,
  createRefusalState,
  createStream,
  decide,
  digestSense,
  evaluateRefusal,
  inferRequestTraits,
  planReturn,
  recent,
  record,
  renderStateLine,
  screenBusy,
  screenSummary,
  surface,
} from '@proj-airi/core-agent'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'

/** One tick per 45 seconds. Fast enough to notice, slow enough to stay cheap. */
const TICK_MS = 45_000

/** How many observations the lane may draw on. */
const OBSERVATION_LIMIT = 8

/** How many seen sense lines are remembered to decide what is new. */
const SENSE_MEMORY = 32

/** Who it is, for friction. A tidy character with a normal patience. */
const personaForFriction = { tidiness: 0.6, patience: 0.5 }

/**
 * 她到底多久才真去想一次。
 *
 * `decide()` 只看驱力：好奇压过阈值就想。但想这件事有成本（一次自循环要读写记忆），
 * 45 秒一跳的驱力会让它在十分钟里想二十次。20 分钟是最短间隔，引擎侧还有
 * `minIntervalHours` 兜底，两层都在。
 */
const THINK_COOLDOWN_MS = 20 * 60_000

/**
 * 一次「想」最多等多久。
 *
 * 引擎是一次子进程 MCP 调用：进程没起来、握手卡住、银行被别的桥独占，都可能让 promise
 * 永远不落地。那样 `thinking` 会一直是 true，她就再也不想了 —— 必须有上限。
 */
const THINK_TIMEOUT_MS = 120_000

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
  /** True once a sense is attached, so a host can show what it can perceive. */
  const senseAttached = ref(false)

  let timer: ReturnType<typeof setInterval> | null = null
  let lastTickAt = Date.now()
  let observations: string[] = []
  let detachTurnComplete: (() => void) | null = null
  /** Where perception comes from. Blind until a host attaches a port. */
  let sense: SensePort = blindSense
  /** Sense lines already seen, oldest first, so the same desktop is not new twice. */
  let seenTexts: string[] = []
  /** Set by `lookAround` and consumed by the next tick. */
  const novelty = ref(false)
  /**
   * How a resident host answers `decide() === 'think'`.
   *
   * The store stays impure but dumb: it knows *when* to think, the host knows
   * *how* (AIRI answers with one Castalia self-cycle, which reads recent
   * conversation and writes a diary entry). Unset means she only daydreams in
   * the local template lane, which is the old behaviour.
   */
  let thinkExecutor: (() => Promise<string | undefined>) | undefined
  let thinking = false
  let lastThinkAt = 0
  /** 可观测：host 有没有把「怎么想」交进来。没接上时 `thinkNow()` 直接返回 false。 */
  const thinkWired = ref(false)
  /** 可观测：现在是不是正在想（卡住时能看见）。 */
  const thinkInFlight = ref(false)
  /** Last thing a real think produced, for the panel and for `poke()`. */
  const lastThinkText = ref<string>()
  const thinkCount = ref(0)
  /** 原始日记正文（保留一节，念头只是它的内化版；诊断要看原文时用这个）。 */
  const lastDiaryText = ref<string>()
  /** 最近一次看到的屏幕（一行描述），由 `lookAround` 写入。 */
  const lastScreenLine = ref<string>()
  /** 感知端自述：走到哪一步、拿到了什么。看不见和坏掉了要靠它区分。 */
  const lastSenseDiagnostics = ref<Record<string, unknown>>()
  /** 她此刻可不可以开口：屏幕在开会/游戏/全屏时置 false。speech ticker 读这个。 */
  const interruptAllowed = ref(true)
  const interruptReason = ref<string>()
  /** 想说话但被挡住时的冷却，避免每秒重算一次屏幕。 */
  let lastProvokeAt = 0

  // How many sends a changed state stays visible. SillyTavern calls the same
  // control "Sticky": an activated entry stays for N messages, then stops on its
  // own. A note near the end of the chat has strong pull, so repeating an
  // unchanged line every turn drowns the persona.
  const STATE_STICKY_SENDS = 3
  let sendsLeft = 0
  let lastSentState = ''

  /**
   * The state line for this send, or an empty string.
   *
   * A change restarts the sticky window. While the state holds, the line rides
   * along for a few sends and then goes quiet, so the model reads it as
   * something that happened rather than a constant instruction.
   */
  function stateLineForSend(): string {
    const line = stateLine.value
    if (!line) {
      lastSentState = ''
      sendsLeft = 0
      return ''
    }

    if (line !== lastSentState) {
      lastSentState = line
      sendsLeft = STATE_STICKY_SENDS
    }

    if (sendsLeft <= 0)
      return ''

    sendsLeft--
    return line
  }

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

  /** Points the mind at something that can look at the world. Unset means blind. */
  function attachSense(port: SensePort | undefined) {
    sense = port ?? blindSense
    senseAttached.value = Boolean(port)
  }

  /**
   * Tells the mind how to actually think when the drives ask for it.
   *
   * AIRI passes one Castalia self-cycle: read the recent conversation, write a
   * diary entry. The returned string is what she "thought about", and it lands
   * in the private stream like any other thought.
   */
  function attachThink(executor: (() => Promise<string | undefined>) | undefined) {
    thinkExecutor = executor
    thinkWired.value = Boolean(executor)
  }

  /**
   * One real think, if the host wired one and the cooldown allows it.
   *
   * Returns whether anything happened, so a probe can assert on it without
   * waiting for the 45 s tick.
   */
  async function thinkNow(now = Date.now()): Promise<boolean> {
    if (!thinkExecutor || thinking)
      return false
    if (now - lastThinkAt < THINK_COOLDOWN_MS)
      return false

    thinking = true
    thinkInFlight.value = true
    try {
      const diary = (await Promise.race([
        thinkExecutor(),
        new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), THINK_TIMEOUT_MS)),
      ]))?.trim()
      if (!diary) {
        // 引擎说「刚想过，还没到间隔」也是没想成：那是正常跳过，不该罚掉 20 分钟，
        // 但也不能每 45 秒问一次，给 3 分钟。
        lastThinkAt = Date.now() - THINK_COOLDOWN_MS + 3 * 60_000
        return false
      }

      lastThinkAt = Date.now()
      lastDiaryText.value = diary
      // 想之前先看一眼此刻的屏幕：不然「思考」和眼前正在发生的事没关系，
      // 读起来就像她在念日记，而不是在过日子。
      if (senseAttached.value)
        await lookAround({ force: true }).catch(() => 0)
      // 日记是「记录」，念头是「自言自语」：把她刚想出来的东西加上刚看到的屏幕，
      // 再接到她自己上一两句上，收敛成一句有连续性的话。
      const text = composeInnerVoice({
        diary,
        screen: lastScreenLine.value,
        previous: recentSelfTalk(2),
        drives: drives.value,
        now: lastThinkAt,
      })
      if (!text)
        return false
      const thought: Thought = {
        id: `think-${lastThinkAt}`,
        at: lastThinkAt,
        text,
        visibility: 'private',
        topic: 'self-cycle',
      }
      stream.value = record(stream.value, thought)
      lastThinkText.value = text
      thinkCount.value += 1
      void innerThoughtsRepo.append(thought).catch(() => {})
      return true
    }
    catch {
      // A failed think must not stop the tick loop; retry in a few minutes.
      lastThinkAt = Date.now() - THINK_COOLDOWN_MS + 3 * 60_000
      return false
    }
    finally {
      thinking = false
      thinkInFlight.value = false
    }
  }

  /**
   * Asks the sense what it can see and feeds the result to the lane.
   *
   * Returning the number of fresh observations keeps this testable without a
   * screen. A host calls it on a timer, or from `tick` as the app grows.
   */
  async function lookAround(options: { force?: boolean } = {}): Promise<number> {
    const observationsSeen = await sense.look().catch(() => [])
    if (sense.diagnostics)
      lastSenseDiagnostics.value = sense.diagnostics()
    const digest = digestSense(observationsSeen, seenTexts)

    // `force`：她要动脑子、或者想出声时，必须看到「此刻」的屏幕，
    // 不能被 digestSense 的「和上次差不多」挡掉。
    const newestObs = [...observationsSeen].reverse().find(item => String(item?.text ?? '').trim())

    if (options.force && newestObs)
      applyScreenLine(String(newestObs.text).replace(/\s+/g, ' ').trim(), newestObs)

    if (!digest.novel)
      return 0

    seenTexts = [...seenTexts, ...digest.texts].slice(-SENSE_MEMORY)
    for (const text of digest.texts)
      observe(text)
    if (newestObs)
      applyScreenLine(String(newestObs.text).replace(/\s+/g, ' ').trim(), newestObs)
    // Something new is what raises curiosity at the next tick.
    novelty.value = true
    return digest.texts.length
  }

  /**
   * 记住「刚看到的」并算出声裁决。
   *
   * 主路是视觉模型的语义判断（`screen:activity` 直接答「他在干嘛 / 能不能打扰」）。
   * 关键词只在感知层没给意见时兜底——那是没有下限的备用路，不是判据。
   */
  function applyScreenLine(line: string, verdict?: { interruptible?: boolean, reason?: string }) {
    lastScreenLine.value = line
    if (typeof verdict?.interruptible === 'boolean') {
      interruptAllowed.value = verdict.interruptible
      interruptReason.value = verdict.reason
      return
    }
    const busy = screenBusy(line)
    interruptAllowed.value = !busy.busy
    interruptReason.value = busy.reason
  }

  /** 想搭话时重新看屏幕的最短间隔：一秒一个 tick，不能每秒抓一次屏。 */
  const PROVOKE_RECHECK_MS = 10 * 60_000

  /**
   * 无聊到想开口时的第一步：看一眼她在干什么。
   *
   * 出声本身不在这个 store 里 —— `self-initiated-speech` 那条管线本来就有节流和静默时段。
   * 这里只负责两件事：把最新的屏幕裁决给它（`interruptAllowed`），以及被挡住时把「想说又
   * 憋回去」这件事变成一句自言自语，而不是产生一个打扰。
   */
  async function considerSpeaking(now = Date.now()): Promise<{ allowed: boolean, reason?: string }> {
    if (now - lastProvokeAt < PROVOKE_RECHECK_MS)
      return { allowed: interruptAllowed.value, reason: interruptReason.value }
    lastProvokeAt = now

    if (senseAttached.value)
      await lookAround({ force: true }).catch(() => 0)

    if (interruptAllowed.value)
      return { allowed: true }

    const text = composeInnerVoice({
      screen: lastScreenLine.value,
      heldReason: 'busy-screen',
      drives: drives.value,
      now,
    })
    if (text) {
      const thought: Thought = {
        id: `hold-${now}`,
        at: now,
        text,
        visibility: 'private',
        topic: 'held-back',
      }
      stream.value = record(stream.value, thought)
      void innerThoughtsRepo.append(thought).catch(() => {})
    }
    return { allowed: false, reason: interruptReason.value ?? 'busy-screen' }
  }

  /** 最近几句自言自语（新的在后），不带日记原文。 */
  function recentSelfTalk(limit = 2): string[] {
    const entries = stream.value.entries ?? []
    return entries
      .filter(t => t.topic === 'self-cycle' || t.topic === 'held-back')
      .slice(-Math.max(1, limit))
      .map(t => String(t.text ?? '').trim())
      .filter(Boolean)
  }

  /**
   * 状态机自己的上下文：她在想什么、看到了什么、现在是什么状态。
   *
   * 这是「自言自语」这一层的自述，和聊天记录是两条线。出声时把它带上去，她开口才是接着
   * 自己刚才那串念头说的，不是凭空冒一句。
   */
  function innerContextLine(limit = 3): string {
    const parts: string[] = []
    const thoughts = recentSelfTalk(limit)
    if (thoughts.length)
      parts.push(`你刚才在心里想：${thoughts.join(' / ')}`)
    const screen = screenSummary(String(lastScreenLine.value ?? ''), 60)
    if (screen)
      parts.push(`你此刻看到：${screen}`)
    const { boredom, curiosity, fatigue } = drives.value
    parts.push(`你现在的状态：无聊 ${Math.round(boredom)} · 好奇 ${Math.round(curiosity)} · 累 ${Math.round(fatigue)}${interruptAllowed.value ? '' : '（屏幕上像是不方便打扰）'}`)
    return parts.join('\n')
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
      novelty: novelty.value,
    })
    novelty.value = false

    // 驱力说话：好奇过阈值就真去想一次；无聊到想搭话时，先看一眼屏幕再决定打不打搅。
    const action = decide(drives.value)
    if (action === 'think')
      void thinkNow(now)
    else if (action === 'provoke')
      void considerSpeaking(now)

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
    stateLineForSend,
    opening,
    wokeUp,
    heldBack,
    initialized,
    initialize,
    observe,
    tick,
    poke,
    attachSense,
    attachThink,
    thinkNow,
    considerSpeaking,
    interruptAllowed,
    interruptReason,
    lastScreenLine,
    lastDiaryText,
    lastSenseDiagnostics,
    innerContextLine,
    thinkWired,
    thinkInFlight,
    lastThinkText,
    thinkCount,
    lookAround,
    senseAttached,
    handoffFor,
    delegations,
    settleDelegation,
    attachTurnComplete,
    dispose,
  }
})
