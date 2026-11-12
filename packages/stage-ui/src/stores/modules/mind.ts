import type { Drives, InnerStream, InterruptionVerdict, NoiseConfig, PresenceReading, SensePort, SleepClock, SleepStageReport, Thought } from '@proj-airi/core-agent'

import {
  advanceDrives,
  beginBout,
  blindSense,
  composeInnerVoice,
  composeThought,
  createRandom,
  createRefusalState,
  createStream,
  dailyJitter,
  decide,
  defaultActionThresholds,
  defaultDriveConfig,
  defaultNapBout,
  defaultNapPolicy,
  defaultNoiseConfig,
  defaultSleepBout,
  digestSense,
  evaluateRefusal,
  inferRequestTraits,
  interruptionVerdict,
  jitteredThresholds,
  markShared,
  noiseDayKey,
  NAP_BOREDOM_RELIEF_PER_MINUTE,
  NAP_QUALITY,
  NAP_WAKE_GAP,
  planReturn,
  recent,
  record,
  relieveAfterSpeech,
  renderStateLine,
  screenBusy,
  seedFrom,
  settleBoutGap,
  sleepQualityFrom,
  stepWobble,
  stillWobble,
  surface,
  withWobble,
} from '@proj-airi/core-agent'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { innerThoughtsRepo } from '../../database/repos/inner-thoughts.repo'
import { ownsLease } from './mind-lease'

/** One tick per 45 seconds. Fast enough to notice, slow enough to stay cheap. */
const TICK_MS = 45_000
/** A lease held by a window that died is taken over after this long. */
const LEASE_TTL_MS = 4 * TICK_MS
/** Shared between windows of the same profile: who is allowed to advance. */
const LEASE_KEY = 'castalia/mind-owner'

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
  /** False in a second window: it displays but does not advance or persist. */
  const isOwner = ref(true)
  const instanceId = `mind-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
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
   * how* (AIRI answers with one Castalia self-cycle, which reads recent
   * conversation and writes a diary entry). Unset means she only daydreams in
   * the local template lane, which is the old behaviour.
   */
  let thinkExecutor: (() => Promise<string | undefined>) | undefined
  let thinking = false
  let lastThinkAt = 0

  /**
   * Sleep: the other half of the fatigue loop.
   *
   * `advanceDrives` raises fatigue on every tick; nothing lowered it unless the
   * app was closed (`restDrives` on the away path). A host that runs for days
   * therefore reached the sleep threshold and stayed there. These fields hold
   * the bout: while `asleep`, the tick advances the sleep clock instead of the
   * awake one, and fatigue falls at the rate the maintenance cycle earned.
   */
  const asleep = ref(false)
  /** A nap is a bout too, just shorter and with no memory work behind it. */
  const napping = ref(false)
  const sleepCount = ref(0)
  const napCount = ref(0)
  const lastSleepQuality = ref(1)
  const sleepWired = ref(false)
  const sleepInFlight = ref(false)
  const lastSleepReport = ref<SleepStageReport>()
  let sleepClock: SleepClock | null = null
  let sleepExecutor: (() => Promise<SleepStageReport | undefined>) | undefined
  /** One maintenance call may take a minute; a hung one must not keep her in bed forever. */
  const SLEEP_EXECUTOR_TIMEOUT_MS = 180_000
  /**
   * When the owner last finished a turn.
   *
   * The old tick passed `idleMs: elapsed`, which is 45 seconds — always under
   * the one-minute "user is active" line, so boredom was relieved on every tick
   * and never grew. That is why provoke almost never fired and why a nap could
   * not have a trigger. Idle has to mean "since the owner spoke", not "since the
   * last tick".
   */
  let lastOwnerAt = Date.now()
  let lastNapAt = 0
  /** Daily cap: a dull afternoon gets one nap, not five. */
  let napsToday = 0
  let napDay = new Date().toDateString()
  function rollNapDay(now: number) {
    const day = new Date(now).toDateString()
    if (day !== napDay) {
      napDay = day
      napsToday = 0
    }
  }

  /**
   * Drives survive a reload.
   *
   * Without this every launch started at zero fatigue and `planReturn` rested
   * from zero, so closing the window was a full battery — the same free refill
   * as `restDrives` on a host that never restarts.
   */
  // Scoped by character: two characters in the same profile must not share a
  // fatigue gauge. `initialize(characterId)` sets it before the first read.
  let mindScope = 'default'
  /** The character this mind belongs to right now. The diary reads it, so a day never mixes two characters. */
  const scope = ref(mindScope)
  // 噪声源：没装时判定完全确定。声明在这里，`switchCharacter` 要按角色重开同一条流。
  let noiseConfig = defaultNoiseConfig
  let noiseRandom: (() => number) | undefined
  let noiseSeedText = ''
  let noiseDay = ''
  let noiseDayOffset = 0
  function mindStateKey(): string {
    return `castalia/mind-state/${mindScope}`
  }
  function loadMindState(): { drives?: Drives, asleep?: boolean, napping?: boolean, clock?: SleepClock, lastNapAt?: number, napsToday?: number, napDay?: string, at?: number } | undefined {
    try {
      // One-time migration: state used to live under the unscoped key.
      const scoped = globalThis.localStorage?.getItem(mindStateKey())
      const raw = scoped ?? (mindScope === 'default' ? null : globalThis.localStorage?.getItem('castalia/mind-state'))
      return raw ? JSON.parse(raw) : undefined
    }
    catch {
      return undefined
    }
  }
  function persistMindState() {
    try {
      globalThis.localStorage?.setItem(mindStateKey(), JSON.stringify({
        drives: drives.value,
        asleep: asleep.value,
        napping: napping.value,
        clock: sleepClock,
        lastNapAt,
        napsToday,
        napDay,
        at: Date.now(),
      }))
    }
    catch { /* 存不下就退化成内存态，不影响本轮 */ }
  }
  /**
   * Takes over another window's snapshot without double-counting.
   *
   * Used when this window becomes the owner (first launch or stale lease). The
   * snapshot carries its own timestamp, so the gap since the previous owner's
   * last tick is settled once, by the tick that calls this.
   */
  function adoptPersisted(now: number) {
    const saved = loadMindState()
    if (!saved)
      return
    if (saved.drives)
      drives.value = saved.drives
    if (saved.clock)
      sleepClock = saved.clock
    lastNapAt = saved.lastNapAt ?? 0
    napsToday = saved.napsToday ?? 0
    napDay = saved.napDay ?? new Date().toDateString()
    asleep.value = Boolean(saved.asleep && saved.clock)
    napping.value = Boolean(saved.napping && saved.clock)
    lastTickAt = Number.isFinite(saved.at) ? Math.min(now, saved.at!) : now
  }

  /**
   * Moves the mind to another character.
   *
   * Drives, the sleep clock, and the diary stream belong to one character. Switching cards must not carry the
   * outgoing character's fatigue or thoughts into the new one, and switching back must resume where she left off,
   * so the outgoing snapshot is persisted under its own key before the swap.
   */
  async function switchCharacter(characterId: string | undefined, now = Date.now()) {
    const next = characterId || 'default'
    if (next === mindScope)
      return
    persistMindState()
    mindScope = next
    scope.value = next
    // 换一个人就是换一颗心：噪声流跟着角色重开，否则两张卡永远同相位。
    if (noiseRandom)
      attachNoise({ seed: Date.now() })

    drives.value = { fatigue: 0, boredom: 0, curiosity: 0, focus: 0 }
    sleepClock = null
    asleep.value = false
    napping.value = false
    lastNapAt = 0
    napsToday = 0
    napDay = new Date(now).toDateString()
    lastTickAt = now

    const saved = await innerThoughtsRepo.readAll().catch(() => [])
    stream.value = createStream()
    for (const thought of saved) {
      // A thought written before the split has no persona. The first character that reads the diary keeps it;
      // leaving it unowned would show one character's day in the other's diary.
      if (!thought.persona) {
        thought.persona = mindScope
        void innerThoughtsRepo.append(thought).catch(() => {})
      }
      if (thought.persona === mindScope)
        stream.value = record(stream.value, thought)
    }

    const remembered = loadMindState()
    if (remembered?.drives)
      drives.value = remembered.drives
    if (remembered?.clock)
      sleepClock = remembered.clock
    lastNapAt = remembered?.lastNapAt ?? 0
    napsToday = remembered?.napsToday ?? 0
    napDay = remembered?.napDay ?? new Date(now).toDateString()
    asleep.value = Boolean(remembered?.asleep && sleepClock)
    napping.value = Boolean(remembered?.napping && sleepClock)
    persistMindState()
  }

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
  // 默认 `false`：这个 ref 只在有裁决时间时才会被读（见 `interruptionInput`），
  // 但默认值是别人「顺手读一下」时的答案。默认 true 等于给未来留了一张「可以打扰」的
  // 通行证——这正是最初那个 bug 的形状。没人说过可以，就是不可以。
  const interruptAllowed = ref(false)
  const interruptReason = ref<string>()
  /**
   * When the last verdict arrived.
   *
   * A verdict answers "was the screen interruptible a moment ago". Vision can fail for hours, and the
   * last `false` then held her quiet with nothing left to refresh it. A caller that finds this stamp
   * older than its own limit must treat the verdict as unknown instead of as a refusal.
   */
  const interruptVerdictAt = ref<number>()
  /** 想说话但被挡住时的冷却，避免每秒重算一次屏幕。 */
  let lastProvokeAt = 0
  /** 上一次真正发起的扫视。定时扫视与开口那一眼撞在一起时用它去重。 */
  let lastLookStartedAt = 0

  /**
   * 主人在不在电脑前（廉价路）。
   *
   * 它不耗模型：主进程读一次系统空闲与锁屏就有。视觉那条路只在扫视和想开口时跑，
   * 又慢又会失败；只靠它，「不知道」就会被当成「不忙」，开口就是一句「你在忙吗」。
   */
  const presence = ref<PresenceReading>()
  /**
   * 裁决里「多久以前」要跟着时间走。
   *
   * computed 只在依赖变化时重算，而时间不是依赖：不给她一个每 tick 前进的时钟，
   * 一条十分钟前的裁决会一直算作「此刻」。
   */
  const verdictClock = ref(Date.now())

  /**
   * 读一次系统状态（锁屏/空闲）。
   *
   * tick 每 45 秒读一次；`lookAround` 抓屏前也读一次——「刚锁屏」是唯一能推翻视觉的
   * 硬事实，45 秒的延迟足够她对着锁屏壁纸说完一整句。
   */
  async function refreshPresence() {
    if (!sense.presence)
      return
    try {
      // 有上限：一次读数挂住不能把 look 也拖住——那一眼是开口的前置。
      const reading = await Promise.race([
        sense.presence(),
        new Promise<undefined>(resolve => setTimeout(resolve, 2_000, undefined)),
      ])
      if (reading)
        presence.value = reading
    }
    catch {
      // 读不到就是不知道。上层把 `unknown` 当「别问忙不忙」，不当「在场」。
    }
  }

  /** 裁决输入：只在这里拼一次，`minAgeMs` 决定「旧裁决最多能用多久」。 */
  function interruptionInput(options: { nowMs?: number, minAgeMs?: number } = {}) {
    const nowMs = options.nowMs ?? verdictClock.value
    if (!lastScreenLine.value && !interruptVerdictAt.value)
      return { presence: presence.value }
    return {
      presence: presence.value,
      screen: {
        activity: lastScreenLine.value,
        // `interruptAllowed` 默认是 true；没有裁决时间就等于没有裁决。
        interruptible: interruptVerdictAt.value ? interruptAllowed.value : undefined,
        reason: interruptReason.value,
        ageMs: interruptVerdictAt.value ? Math.max(0, nowMs - interruptVerdictAt.value) : undefined,
        minAgeMs: options.minAgeMs,
      },
    }
  }

  /** 猜错方向的代价不对称：多问一句是打扰，少说一句只是安静。 */
  const interruption = computed<InterruptionVerdict>(() => interruptionVerdict(interruptionInput()))

  /**
   * 用真实时钟算的裁决。
   *
   * `interruption` 走 tick 时钟，年龄最多少算 45 秒；普通对话每轮读的那一句和门上的
   * 判断都要「现在」，不要「上一次 tick」。
   */
  function interruptionNow(): InterruptionVerdict {
    return interruptionVerdict(interruptionInput({ nowMs: Date.now() }))
  }

  /**
   * 只认「这一眼之后」的裁决。
   *
   * 开口前强制看过一次，就用它的起点当门槛：看一眼超时、或者视觉只回了描述
   * 没回裁决时，几分钟前那条 `free` 不能当作「他现在不忙」的许可。
   * 用真实时钟而不是 tick 时钟——开口那一刻等不了下一个 45 秒。
   */
  function interruptionSince(startedAt: number): InterruptionVerdict {
    const now = Date.now()
    return interruptionVerdict(interruptionInput({ nowMs: now, minAgeMs: Math.max(0, now - startedAt) }))
  }

  /**
   * 进提示词的一句，只在接了感知时给。
   *
   * 没接感知的用户不该在每轮里读到「你看不到屏幕」——那不是信息，是噪音。
   * 开口那一刻传 `minAgeMs`：她读到的裁决必须和刚才用来做决定的是同一份，
   * 否则会出现「决定说不知道、嘴上却说主人不忙」。
   */
  function interruptionLine(minAgeMs?: number): string {
    if (!senseAttached.value)
      return ''
    const verdict = minAgeMs === undefined
      ? interruptionNow()
      : interruptionVerdict(interruptionInput({ nowMs: Date.now(), minAgeMs }))
    return verdict.line ?? ''
  }

  // How many sends a changed state stays visible. SillyTavern calls the same
  // control "Sticky": an activated entry stays for N messages, then stops on its
  // own. A note near the end of the chat has strong pull, so repeating an
  // unchanged line every turn drowns the persona.
  const STATE_STICKY_SENDS = 3
  let sendsLeft = 0
  let lastSentState = ''

  /** The line a prompt may carry, or an empty string when nothing is worth it. */
  const stateLine = computed(() => renderStateLine({
    drives: drives.value,
    slept: wokeUp.value,
    heldBack: Boolean(heldBack.value),
  }))

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
    // 端口摘掉后旧的占用读数不再属于任何人：留着会让「离开」一直生效。
    if (!port)
      presence.value = undefined
  }

  /**
   * 她此刻的心情抖动，和今天这个人的阈值偏移。
   *
   * 未装噪声时判定完全确定（纯测试要的就是这个）。装上之后：驱力每跳在 OU 过程上漂一点、
   * 阈值按日期取一次偏移、贴着 think 线的那次选择掷一次骰子。噪声只改「做什么、什么时候做」，
   * 不写进任何记录，也不碰「能不能打扰」那条裁决。
   */
  const wobble = ref(stillWobble(Date.now()))
  /** 今天的阈值偏移，给面板看。0 表示没有装噪声。 */
  const todayOffset = ref(0)

  /**
   * 装上噪声源。宿主在 `attachSense` 之后调用；不调用就是原来的确定性循环。
   *
   * `seed` 让一个角色的一天可以重放：同一个种子跑出同一条轨迹，测试才问得出
   * 「噪声有没有改变行为」，而不是连自己都复现不了。
   */
  function attachNoise(options?: { config?: Partial<NoiseConfig>, seed?: number }) {
    if (options?.config)
      noiseConfig = { ...defaultNoiseConfig, ...options.config }
    noiseSeedText = `${mindScope}\u0000${options?.seed ?? Date.now()}`
    noiseRandom = createRandom(seedFrom(noiseSeedText))
    noiseDay = ''
    noiseDayOffset = 0
    wobble.value = stillWobble(Date.now())
  }

  function dayOffsetFor(now: number): number {
    if (!noiseRandom)
      return 0
    // 分区点在 04:00：偏移在睡着的时候换，不在零点当着她的面跳十点。
    const day = noiseDayKey(now)
    if (day !== noiseDay) {
      noiseDay = day
      noiseDayOffset = dailyJitter(noiseSeedText, day, noiseConfig)
    }
    return noiseDayOffset
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
   * Tells the mind how to spend a night.
   *
   * AIRI passes one Castalia maintenance call: reflect, consolidate, digest.
   * The report is reduced to the three booleans sleep cares about, so the
   * recovery rate reflects what actually ran. No executor still sleeps — just
   * at half rate — because a missing memory backend must not mean insomnia.
   */
  function attachSleep(executor: (() => Promise<SleepStageReport | undefined>) | undefined) {
    sleepExecutor = executor
    sleepWired.value = Boolean(executor)
  }

  /** 一觉醒来注意力是新的：夜睡也要把无聊付掉，否则她睁眼第一跳就「无聊到想说话」。 */
  const SLEEP_BOREDOM_RELIEF = 25

  /** Ends a night. Returns whether there was one to end. */
  function wakeUp(): boolean {
    if (!asleep.value)
      return false
    asleep.value = false
    sleepClock = null
    sleepCount.value += 1
    wokeUp.value = true
    drives.value = { ...drives.value, boredom: Math.max(0, drives.value.boredom - SLEEP_BOREDOM_RELIEF) }
    persistMindState()
    return true
  }

  /**
   * Ends a nap. A nap is not a night: it does not raise `wokeUp`, because the
   * state line should not tell the owner she "slept" after twenty minutes.
   */
  function endNap(now = Date.now()): boolean {
    if (!napping.value)
      return false
    napping.value = false
    sleepClock = null
    lastNapAt = now
    napCount.value += 1
    // A doze takes the edge off "nothing to do" as well; without this she wakes
    // exactly as bored as she lay down and the nap buys nothing.
    drives.value = { ...drives.value, boredom: Math.max(0, drives.value.boredom - 15) }
    persistMindState()
    return true
  }

  /**
   * Dozes off for a bounded stretch.
   *
   * No maintenance call: a nap must cost nothing, otherwise the cheapest way to
   * be bored would become the most expensive. Recovery stops at its own cap or
   * `NAP_WAKE_GAP` points above where it started, so it is a lift, not a night.
   */
  function napNow(now = Date.now()): boolean {
    if (asleep.value || napping.value || sleepInFlight.value)
      return false
    if (drives.value.fatigue >= 80)
      return false
    rollNapDay(now)
    if (napsToday >= defaultNapPolicy.maxPerDay)
      return false
    napsToday += 1
    const wakeAt = Math.max(20, drives.value.fatigue - NAP_WAKE_GAP)
    napping.value = true
    sleepClock = beginBout(now, { quality: NAP_QUALITY, wakeAt, ...defaultNapBout })
    persistMindState()
    return true
  }

  /**
   * Lies down and runs the night's maintenance, once.
   *
   * The maintenance call starts now but the bout lasts as long as the gauge
   * needs. Until the report lands the recovery runs at half rate, then at the
   * rate the report earned — a failed consolidation is a lighter sleep, so she
   * naturally stays down longer instead of waking "rested" on paper.
   */
  async function sleepNow(now = Date.now()): Promise<boolean> {
    if (asleep.value || napping.value || sleepInFlight.value)
      return false

    napping.value = false
    asleep.value = true
    sleepInFlight.value = true
    sleepClock = beginBout(now, {
      quality: sleepCount.value === 0 ? 0.5 : lastSleepQuality.value,
      ...defaultSleepBout,
    })
    persistMindState()

    if (!sleepExecutor) {
      lastSleepQuality.value = 0.5
      sleepClock.quality = 0.5
      sleepInFlight.value = false
      return true
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const report = await Promise.race([
        sleepExecutor(),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(resolve, SLEEP_EXECUTOR_TIMEOUT_MS, undefined)
        }),
      ])
      lastSleepReport.value = report
      lastSleepQuality.value = sleepQualityFrom(report)
    }
    catch {
      lastSleepQuality.value = 0.4
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }

    // The clock may have woken her already if the call took longer than the cap.
    if (sleepClock)
      sleepClock.quality = lastSleepQuality.value
    sleepInFlight.value = false
    persistMindState()
    return true
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
        new Promise<undefined>(resolve => setTimeout(resolve, THINK_TIMEOUT_MS, undefined)),
      ]))?.trim()
      if (!diary) {
        // 引擎说「刚想过，还没到间隔」也是没想成：那是正常跳过，不该罚掉 20 分钟，
        // 但也不能每 45 秒问一次，给 3 分钟。
        lastThinkAt = Date.now() - THINK_COOLDOWN_MS + 3 * 60_000
        return false
      }

      lastThinkAt = Date.now()
      lastDiaryText.value = diary
      // A thought that landed is engagement with internal information, which
      // counts as attention spent (Eastwood 2012), not as idle time.
      drives.value = {
        ...drives.value,
        boredom: Math.max(0, drives.value.boredom - defaultDriveConfig.boredomReliefOnThink),
      }
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
        persona: mindScope,
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
    const now = Date.now()
    // 非强制的扫视：一分钟内刚看过就不再抓。五分钟的定时器和开口前那一眼
    // 可能撞在一起，重复抓屏既花钱又没必要；`force` 的那一眼不受限制。
    if (!options.force && now - lastLookStartedAt < 60_000)
      return 0
    lastLookStartedAt = now
    // 抓屏前先把锁屏状态刷新一次：锁着的屏幕上只有壁纸，视觉会说「可以打扰」。
    await refreshPresence()
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
      interruptVerdictAt.value = Date.now()
      return
    }
    // 只有描述、没有裁决：关键词只能否决，不能放行。
    // 旧代码在没匹配上时写 `interruptAllowed = true`，于是一次解析失败
    // 就变成一张「可以打扰」的通行证——和把 unknown 当成 free 是同一个错。
    const busy = screenBusy(line)
    if (!busy.busy)
      return
    interruptAllowed.value = false
    interruptReason.value = busy.reason
    interruptVerdictAt.value = Date.now()
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
    if (now - lastProvokeAt < PROVOKE_RECHECK_MS) {
      const cached = interruptionNow()
      return { allowed: cached.level === 'free', reason: cached.reason }
    }
    lastProvokeAt = now

    if (senseAttached.value)
      await lookAround({ force: true }).catch(() => 0)

    // 只有「看得见他现在不忙」才算可以搭话。`unknown` 不是许可——
    // 旧代码读 `interruptAllowed` 的默认值 true，把没看见当成可以开口。
    const verdict = interruptionNow()
    if (verdict.level === 'free')
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
        persona: mindScope,
      }
      stream.value = record(stream.value, thought)
      void innerThoughtsRepo.append(thought).catch(() => {})
    }
    return { allowed: false, reason: verdict.reason ?? 'busy-screen' }
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
   * Marks the thought she actually repeated out loud.
   *
   * The diary's "said out loud" column had no producer at all: every thought was written as
   * private and nothing ever flipped it, so the column could only ever read zero. The utterance
   * is generated rather than copied, so the link is textual: a thought counts as said when the
   * delivered line repeats it. No match means nothing was said aloud, which is the normal case.
   */
  function markSaidOutLoud(said: string): Thought | undefined {
    const spoken = String(said ?? '').replace(/\s+/gu, '')
    if (spoken.length < 6)
      return undefined
    const entries = stream.value.entries ?? []
    const match = [...entries].reverse().find((thought) => {
      if (thought.visibility !== 'private')
        return false
      if (thought.topic !== 'self-cycle' && thought.topic !== 'held-back')
        return false
      const core = String(thought.text ?? '')
        .replace(/^noticed:\s*/iu, '')
        .replace(/[。！？…\s「」『』"'“”]/gu, '')
      return core.length >= 6 && spoken.includes(core)
    })
    if (!match)
      return undefined
    stream.value = markShared(stream.value, match.id)
    const updated: Thought = { ...match, visibility: 'shared' }
    void innerThoughtsRepo.append(updated).catch(() => {})
    return updated
  }

  /**
   * 真的说出口了：付出一段注意力，换一段安静。
   *
   * 不接这一步，下一跳仍读到满格无聊，于是每 10 分钟「想说话」一次、每次都抓一次屏。
   */
  function relieveAfterSpeaking() {
    drives.value = relieveAfterSpeech(drives.value)
    persistMindState()
  }

  /**
   * 状态机自己的上下文：她在想什么、看到了什么、现在是什么状态。
   *
   * 这是「自言自语」这一层的自述，和聊天记录是两条线。出声时把它带上去，她开口才是接着
   * 自己刚才那串念头说的，不是凭空冒一句。
   */
  function innerContextLine(limit = 3, options: { minAgeMs?: number } = {}): string {
    const parts: string[] = []
    const thoughts = recentSelfTalk(limit)
    if (thoughts.length)
      parts.push(`你刚才在心里想：${thoughts.join(' / ')}`)
    // 「此刻看到」和「能不能打扰」是同一件事的两面。分开写时她只看见画面、
    // 看不见结论，就会开口问一句本可以自己回答的「你在忙吗」。
    // 没有感知时也保留这一句：它的主要指令是「别问忙不忙」，而那正是这条链要治的病；
    // 普通对话的 `interruptionLine()` 才按「没接感知就不出声」处理。
    const verdict = options.minAgeMs === undefined
      ? interruption.value
      : interruptionVerdict(interruptionInput({ nowMs: Date.now(), minAgeMs: options.minAgeMs }))
    if (verdict.line)
      parts.push(verdict.line)
    const { boredom, curiosity, fatigue } = drives.value
    parts.push(`你现在的状态：无聊 ${Math.round(boredom)} · 好奇 ${Math.round(curiosity)} · 累 ${Math.round(fatigue)}${asleep.value ? '（正在睡）' : napping.value ? '（在打盹）' : ''}`)
    return parts.join('\n')
  }

  /** Advances every drive and lets the background lane write at most one thought. */
  function tick(now = Date.now()) {
    const wasOwner = isOwner.value
    if (!ownsLease(globalThis.localStorage, LEASE_KEY, instanceId, now, LEASE_TTL_MS)) {
      isOwner.value = false
      lastTickAt = now
      return
    }
    isOwner.value = true
    if (!wasOwner)
      adoptPersisted(now)

    // 廉价的一路先读：它不花 token，所以每 tick 都问。视觉那条要起截图和模型，
    // 留给扫视与开口那一刻。
    verdictClock.value = now
    void refreshPresence()

    const elapsed = Math.max(0, now - lastTickAt)
    lastTickAt = now

    // Asleep: only the sleep clock runs. Adding awake fatigue here would mean
    // the night never ends, and thinking/speaking during it would defeat it.
    if ((asleep.value || napping.value) && sleepClock) {
      // A suspended laptop wakes us with a two-hour delta. Settle to the bout's
      // boundary and treat the rest as awake, or the nap cap never applies.
      const step = settleBoutGap(sleepClock, drives.value, now, {
        boredomReliefPerMinute: napping.value ? NAP_BOREDOM_RELIEF_PER_MINUTE : 0,
      })
      sleepClock = step.clock
      drives.value = step.drives
      persistMindState()
      // One predicate for both bouts: a night ends under its wake threshold,
      // a nap on that threshold or its 35-minute cap.
      if (step.closed) {
        if (napping.value)
          endNap(now)
        else
          wakeUp()
      }
      return
    }

    // Real idle: since the owner last spoke, not since the last tick. The old
    // `idleMs: elapsed` was 45 s, which reads as "user active" forever, so
    // boredom was relieved on every tick and could never reach a nap.
    rollNapDay(now)
    const idleMs = Math.max(0, now - lastOwnerAt)
    drives.value = advanceDrives(drives.value, elapsed, {
      idleMs,
      fullscreen: false,
      micActive: false,
      hourOfDay: new Date(now).getHours(),
      novelty: novelty.value,
    })
    novelty.value = false
    persistMindState()

    // 驱力说话：累到阈值就睡；长时间没人又无聊就小睡；好奇过阈值就真去想一次；
    // 无聊到想搭话时，先看一眼屏幕再决定打不打搅。
    // 装了噪声就带上：这一眼的心情抖动 + 今天这个人的阈值偏移 + 靠线那次掷的骰子。
    if (noiseRandom)
      wobble.value = stepWobble(wobble.value, now, noiseConfig, noiseRandom)
    todayOffset.value = dayOffsetFor(now)
    const action = decide(
      noiseRandom ? withWobble(drives.value, wobble.value) : drives.value,
      noiseRandom ? jitteredThresholds(defaultActionThresholds, todayOffset.value) : defaultActionThresholds,
      {
        idleMs,
        sinceNapMs: lastNapAt ? now - lastNapAt : undefined,
        napsToday,
        random: noiseRandom,
      },
    )
    if (action === 'sleep') {
      void sleepNow(now)
      return
    }
    if (action === 'nap') {
      napNow(now)
      return
    }
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
    thought.persona ??= mindScope
    stream.value = record(stream.value, thought)
    void innerThoughtsRepo.append(thought).catch(() => {})
  }

  /** Loads the stream, reports what happened while away, and starts the tick. */
  async function initialize(characterId?: string) {
    if (initialized.value)
      return
    initialized.value = true
    if (characterId)
      mindScope = characterId
    // The first window to get here owns the mind; the others only display it.
    isOwner.value = ownsLease(globalThis.localStorage, LEASE_KEY, instanceId, Date.now(), LEASE_TTL_MS)

    const [saved, lastSeenAt] = await Promise.all([
      innerThoughtsRepo.readAll().catch(() => []),
      innerThoughtsRepo.readLastSeenAt().catch(() => undefined),
    ])

    for (const thought of saved)
      stream.value = record(stream.value, thought)

    // Load the drives before deciding what the away time meant. Otherwise a
    // restart starts from zero, `planReturn` rests a battery that was never
    // spent, and the awake branch below then copies that result over the saved
    // drives — a restart at fatigue 70 came back at 0.
    const remembered = loadMindState()
    if (remembered?.drives)
      drives.value = remembered.drives
    if (remembered?.clock)
      sleepClock = remembered.clock
    lastNapAt = remembered?.lastNapAt ?? 0
    napsToday = remembered?.napsToday ?? 0
    napDay = remembered?.napDay ?? new Date().toDateString()
    rollNapDay(Date.now())
    asleep.value = Boolean(remembered?.asleep && sleepClock)
    napping.value = Boolean(remembered?.napping && sleepClock)
    // Coming back from a shutdown is not the same as being interrupted: the
    // owner has been away too, so a nap counter starts fresh.
    lastOwnerAt = Date.now()

    // The saved snapshot says how long the process was gone; the thought log
    // only knows when she last spoke. Prefer the snapshot, fall back to the log.
    const awayFrom = remembered?.at ?? lastSeenAt
    const awayMs = awayFrom ? Math.max(0, Date.now() - awayFrom) : 0
    const report = planReturn({
      awayMs,
      drives: drives.value,
      journal: recent(stream.value, 20),
      hourOfDay: new Date().getHours(),
    })

    if ((asleep.value || napping.value) && sleepClock) {
      // The app was closed mid-bout: credit the away time at the bout's rate and
      // keep it open if she is still under. Stop at the bout's own boundary and
      // settle the rest as awake time, or a 35-minute nap eats the whole gap.
      const step = settleBoutGap(sleepClock, drives.value, Date.now(), {
        boredomReliefPerMinute: napping.value ? NAP_BOREDOM_RELIEF_PER_MINUTE : 0,
      })
      sleepClock = step.clock
      drives.value = step.drives
      if (step.closed) {
        if (napping.value) {
          napping.value = false
          lastNapAt = Date.now()
          napCount.value += 1
        }
        else {
          asleep.value = false
          sleepCount.value += 1
          wokeUp.value = true
        }
        sleepClock = null
      }
      opening.value = report.opening
    }
    else {
      drives.value = report.drives
      wokeUp.value = report.slept
      opening.value = report.opening
    }

    if (isOwner.value)
      persistMindState()
    lastTickAt = Date.now()
    timer = setInterval(tick, TICK_MS)
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
      // The owner spoke: a night or a nap ends here, not at the wake threshold.
      // She answers first — nothing in the reply path is gated by sleep — and
      // the bout closes afterwards so the state line matches what just happened.
      lastOwnerAt = Date.now()
      if (asleep.value)
        wakeUp()
      if (napping.value)
        endNap(Date.now())
      drives.value = {
        ...drives.value,
        fatigue: Math.min(100, drives.value.fatigue + 1),
        focus: Math.min(100, drives.value.focus + 2),
        // A real exchange is the one thing that pays boredom down. Typing in
        // another window does not: she is in the room and still unengaged.
        boredom: Math.max(0, drives.value.boredom - defaultDriveConfig.boredomReliefOnTurn),
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
    isOwner,
    initialize,
    scope,
    switchCharacter,
    observe,
    tick,
    poke,
    attachSense,
    attachNoise,
    wobble,
    todayOffset,
    noiseEnabled: computed(() => Boolean(noiseRandom)),
    attachThink,
    attachSleep,
    thinkNow,
    sleepNow,
    napNow,
    wakeUp,
    endNap,
    asleep,
    napping,
    sleepCount,
    napCount,
    lastNapAt: computed(() => lastNapAt),
    lastSleepQuality,
    lastSleepReport,
    sleepWired,
    sleepInFlight,
    considerSpeaking,
    interruption,
    interruptionNow,
    interruptionSince,
    interruptionLine,
    relieveAfterSpeaking,
    presence,
    interruptAllowed,
    interruptReason,
    interruptVerdictAt,
    lastScreenLine,
    lastDiaryText,
    lastSenseDiagnostics,
    innerContextLine,
    markSaidOutLoud,
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
