/**
 * Homeostatic drives.
 *
 * Four slow numbers make autonomy feel alive: the companion wants to talk
 * because it is bored, or stays quiet because it is tired. This module holds
 * no timer and no model. It turns elapsed time and environment signals into
 * the next drive values.
 *
 * Source: `integrations/satori-bot/src/core/loop/scheduler.ts` runs a periodic
 * loop. That loop decides what to do from unread events only. The drives below
 * add the missing input: how the companion itself is doing.
 */

/** A value between 0 and 100. */
export type Gauge = number

export interface Drives {
  /** Grows while awake. A tired companion stops interrupting. */
  fatigue: Gauge
  /**
   * Grows while attention has nothing to hold on to — even if the owner is
   * busy in another window. A bored companion looks for something to do.
   */
  boredom: Gauge
  /** Spikes on novelty, then decays. A curious companion investigates. */
  curiosity: Gauge
  /** Rises while the user works. A focused companion stays out of the way. */
  focus: Gauge
}

export interface EnvironmentSignals {
  /** Milliseconds since the last user input or system-wide activity. */
  idleMs: number
  /** The application in front. Absent when the host cannot observe it. */
  foreground?: { app: string, title: string }
  /** A fullscreen application covers the desktop. */
  fullscreen: boolean
  /** The microphone picks up input, for example a call or a recording. */
  micActive: boolean
  /** Local hour, 0 to 23. */
  hourOfDay: number
  /** Something new appeared. The host sets it once per observation. */
  novelty?: boolean
}

/** The environment that lets the companion run before any host sensor exists. */
export const quietEnvironment: EnvironmentSignals = {
  idleMs: 0,
  fullscreen: false,
  micActive: false,
  hourOfDay: 12,
}

export interface DriveConfig {
  fatiguePerMinute: number
  fatigueRecoverPerHour: number
  /**
   * Logistic onset rate. Human boredom saturates: it builds while attention
   * fails, then flattens instead of climbing in a straight line.
   * Source: Eastwood et al. 2012 (boredom = failure to engage attention);
   * Goetz et al. 2014 (boredom has a plateau, not a single ramp).
   */
  boredomPerMinute: number
  /**
   * One real exchange, applied once per turn by the host.
   * A user typing in another window is not engagement: she is in the room and
   * still unengaged, which is the most common kind of human boredom.
   */
  boredomReliefOnTurn: number
  /** Something new to look at: attention found an object. */
  boredomReliefOnNovelty: number
  /** A thought that landed. Internal engagement counts too (Eastwood 2012). */
  boredomReliefOnThink: number
  /** Crossing the provoke line primes exploration, not just talking (Bench & Lench 2013). */
  boredomCuriositySpike: number
  curiosityHalfLifeMs: number
  curiositySpikeOnNovelty: number
  focusRisePerMinute: number
  focusDecayPerMinute: number
}

/**
 * Boredom at which the companion starts looking for alternatives.
 * Source: Bench & Lench 2013 — boredom motivates pursuit of a new goal, not
 * complaint about the old one; van Tilburg & Igou 2012 — it is the felt lack
 * of challenge and meaning, not the absence of people.
 */
export const BOREDOM_SEEKING_ONSET = 60


/**
 * Defaults assume a desktop companion that runs all day.
 * A full battery of boredom takes about 40 minutes of silence.
 * A full battery of fatigue takes about 20 hours awake, so one workday fits.
 * A full night of rest clears a full battery of fatigue.
 */
export const defaultDriveConfig: DriveConfig = {
  fatiguePerMinute: 0.08,
  fatigueRecoverPerHour: 12.5,
  // 2.2/min with saturation: 60 around 42 min, 75 around 63 min, 90 around 105 min.
  boredomPerMinute: 2.2,
  boredomReliefOnTurn: 12,
  boredomReliefOnNovelty: 25,
  boredomReliefOnThink: 8,
  boredomCuriositySpike: 60,
  curiosityHalfLifeMs: 10 * 60_000,
  curiositySpikeOnNovelty: 30,
  focusRisePerMinute: 6,
  focusDecayPerMinute: 2,
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** A user who typed in the last minute is working. A fullscreen app holds their attention. */
export function userIsActive(signals: EnvironmentSignals) {
  return signals.idleMs < 60_000 && !signals.fullscreen
}

/**
 * Advances every drive by one elapsed interval.
 *
 * The function is pure. It takes the previous drives and returns the next
 * ones, so a test can pin exact inputs to exact outputs.
 */
export function advanceDrives(
  previous: Drives,
  elapsedMs: number,
  signals: EnvironmentSignals,
  config: DriveConfig = defaultDriveConfig,
): Drives {
  const minutes = Math.max(0, elapsedMs) / 60_000
  const active = userIsActive(signals)

  const fatigue = clamp(previous.fatigue + minutes * config.fatiguePerMinute, 0, 100)

  // Boredom is unengaged attention, not silence: it grows even while the owner
  // types in another window, and only an actual exchange pays it down.
  const room = Math.max(0.05, 1 - previous.boredom / 100)
  const boredomGain = minutes * config.boredomPerMinute * room
  const boredomRelief = signals.novelty ? config.boredomReliefOnNovelty : 0
  const boredom = clamp(previous.boredom + boredomGain - boredomRelief, 0, 100)

  const curiosityDecay = Math.pow(0.5, Math.max(0, elapsedMs) / config.curiosityHalfLifeMs)
  const noveltySpike = signals.novelty ? config.curiositySpikeOnNovelty : 0
  // Boredom is a switching signal: once it crosses the line she starts looking
  // for something to do, so exploration gets first refusal before speech.
  const startsSeeking = previous.boredom < BOREDOM_SEEKING_ONSET && boredom >= BOREDOM_SEEKING_ONSET
  const seekingSpike = startsSeeking ? config.boredomCuriositySpike : 0
  const curiosity = clamp(previous.curiosity * curiosityDecay + noveltySpike + seekingSpike, 0, 100)

  const focus = active
    ? clamp(previous.focus + minutes * config.focusRisePerMinute, 0, 100)
    : clamp(previous.focus - minutes * config.focusDecayPerMinute, 0, 100)

  return { fatigue, boredom, curiosity, focus }
}

/**
 * Recovers fatigue while the process did not run.
 *
 * A companion that only adds fatigue ends up asleep forever after one day.
 * Source: the same reason a tamagotchi needs a night cycle.
 */
export function restDrives(
  previous: Drives,
  offlineMs: number,
  config: DriveConfig = defaultDriveConfig,
): Drives {
  const hours = Math.max(0, offlineMs) / 3_600_000
  const fatigue = clamp(previous.fatigue - hours * config.fatigueRecoverPerHour, 0, 100)
  return { ...previous, fatigue }
}

/**
 * Recovers fatigue while the process is still running.
 *
 * `restDrives` only covers time the app was closed, so a host that never shuts
 * down never lets her rest — the gauge climbs to the sleep threshold and stays
 * there. This is the online half: the same recovery rate, scaled by how well
 * the sleep cycle went (a failed consolidation is a lighter sleep, not a full
 * battery). It touches fatigue only; boredom and curiosity stay where they are.
 */
export function sleepDrives(
  previous: Drives,
  elapsedMs: number,
  quality = 1,
  config: DriveConfig = defaultDriveConfig,
): Drives {
  const hours = Math.max(0, elapsedMs) / 3_600_000
  const q = clamp(Number.isFinite(quality) ? quality : 0, 0, 1)
  const fatigue = clamp(previous.fatigue - hours * config.fatigueRecoverPerHour * q, 0, 100)
  return { ...previous, fatigue }
}

/**
 * Applies the relief of one spoken invitation.
 *
 * Without this the next tick still reads full boredom, so the companion would
 * invite again at every cooldown. Speaking costs attention and buys quiet.
 */
export function relieveAfterSpeech(previous: Drives): Drives {
  return {
    ...previous,
    boredom: clamp(previous.boredom - 45, 0, 100),
    curiosity: clamp(previous.curiosity - 10, 0, 100),
  }
}

export interface Gates {
  /** The companion may start a conversation. */
  allowProvoke: boolean
  /** The companion may think privately, without speaking. */
  allowThink: boolean
}

export interface GateConfig {
  quietHoursStart: number
  quietHoursEnd: number
  fullscreenBlocks: boolean
  audioCaptureBlocks: boolean
}

export const defaultGateConfig: GateConfig = {
  quietHoursStart: 0,
  quietHoursEnd: 8,
  fullscreenBlocks: true,
  audioCaptureBlocks: true,
}

/** Handles a window such as 22 to 7 that crosses midnight. */
export function isQuietHour(hourOfDay: number, config: GateConfig = defaultGateConfig) {
  const { quietHoursStart: start, quietHoursEnd: end } = config
  if (start === end)
    return false
  return start < end
    ? hourOfDay >= start && hourOfDay < end
    : hourOfDay >= start || hourOfDay < end
}

/**
 * Turns environment signals into the two permission flags.
 *
 * Thinking stays allowed while speaking does not, because a private thought
 * costs the user nothing. This split is what keeps the companion from
 * becoming a popup machine.
 */
export function gatesFrom(
  signals: EnvironmentSignals,
  config: GateConfig = defaultGateConfig,
): Gates {
  const blockedByScreen = config.fullscreenBlocks && signals.fullscreen
  const blockedByAudio = config.audioCaptureBlocks && signals.micActive
  const blockedByHour = isQuietHour(signals.hourOfDay, config)
  const blocked = blockedByScreen || blockedByAudio || blockedByHour
  return { allowProvoke: !blocked, allowThink: true }
}

export type MindAction = 'idle' | 'think' | 'provoke' | 'sleep' | 'nap'

export interface ActionThresholds {
  /** Above this fatigue the companion rests instead of acting. */
  sleep: number
  /** Below this fatigue a resting companion can act again. */
  wake: number
  /** Boredom that makes the companion want to talk. */
  provoke: number
  /** Curiosity that makes the companion investigate. */
  think: number
  /** Boredom at which an idle, mildly tired companion dozes instead of talking. */
  napBoredom: number
  /** Below this fatigue a nap is pointless: she is not tired enough to switch off. */
  napFatigue: number
  /** Quiet this long before a night can start; otherwise she dozes mid-chat. */
  sleepIdleMs: number
}

export const defaultActionThresholds: ActionThresholds = {
  sleep: 80,
  // A night has to actually restore her. Waking at 55 would end every bout
  // after two hours and leave her permanently half-tired; 20 is a full sleep.
  wake: 20,
  provoke: 60,
  think: 55,
  napBoredom: 75,
  napFatigue: 35,
  sleepIdleMs: 10 * 60_000,
}

/** What the loop knows and the drives do not. */
export interface MindContext {
  /** Milliseconds since the owner last said anything. */
  idleMs?: number
  /** Milliseconds since the last nap ended. Absent means never. */
  sinceNapMs?: number
  /** Naps already taken today, so a dull afternoon cannot become five naps. */
  napsToday?: number
}

export interface NapPolicy {
  /** A nap needs a long quiet stretch, not a lull between two messages. */
  idleMs: number
  /** At least this long between two naps. */
  cooldownMs: number
  /** Hard daily cap. Two is an afternoon and an evening, not a hibernation. */
  maxPerDay: number
}

export const defaultNapPolicy: NapPolicy = {
  idleMs: 45 * 60_000,
  cooldownMs: 3 * 3_600_000,
  maxPerDay: 2,
}

/**
 * Whether this is a nap moment.
 *
 * Boredom alone is not enough: a bored companion talks. Fatigue alone is not
 * enough: a tired companion with something to do keeps going. A nap needs the
 * intersection — nothing to do, quiet long enough, tired enough that a short
 * doze helps, and not so tired that the night has already started. Pure, so the
 * decision is testable without a clock.
 */
export function canNap(
  drives: Drives,
  context: MindContext = {},
  thresholds: ActionThresholds = defaultActionThresholds,
  policy: NapPolicy = defaultNapPolicy,
): boolean {
  const idle = Math.max(0, context.idleMs ?? 0)
  const sinceNap = context.sinceNapMs ?? Number.POSITIVE_INFINITY
  if ((context.napsToday ?? 0) >= policy.maxPerDay)
    return false
  return drives.boredom >= thresholds.napBoredom
    && drives.fatigue >= thresholds.napFatigue
    && drives.fatigue < thresholds.sleep
    && idle >= policy.idleMs
    && sinceNap >= policy.cooldownMs
}

/**
 * Picks what the companion wants to do, before any gate applies.
 *
 * This is intent, not permission. The gates live in `planExpression`, which
 * decides whether the intent becomes speech, a bubble, or a held-back thought.
 * Mixing the two here made "wants to talk but is blocked" impossible.
 *
 * Only onsets live here. How a sleep or a nap ends belongs to the bout clock
 * (`beginBout` / `advanceBout`): a night ends on a fatigue threshold, a nap on
 * a wake threshold *and* a duration cap, and splitting those across two
 * functions is what produced the flip-flopping this replaced.
 */
export function decide(
  drives: Drives,
  thresholds: ActionThresholds = defaultActionThresholds,
  context: MindContext = {},
  policy: NapPolicy = defaultNapPolicy,
): MindAction {
  const idle = Math.max(0, context.idleMs ?? 0)
  if (drives.fatigue >= thresholds.sleep && idle >= thresholds.sleepIdleMs)
    return 'sleep'
  if (canNap(drives, context, thresholds, policy))
    return 'nap'
  if (drives.boredom >= thresholds.provoke) {
    // Boredom is a switching signal, not a complaint: if something also looks
    // worth investigating, she goes and looks before she asks for company.
    // Source: Bench & Lench 2013 — boredom readies pursuit of alternatives.
    if (drives.curiosity >= thresholds.think)
      return 'think'
    return 'provoke'
  }
  if (drives.curiosity >= thresholds.think)
    return 'think'
  return 'idle'
}
