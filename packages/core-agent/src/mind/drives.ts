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
  /** Grows while the user is quiet. A bored companion looks for something to do. */
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
  boredomPerMinute: number
  boredomReliefPerMinute: number
  curiosityHalfLifeMs: number
  curiositySpikeOnNovelty: number
  focusRisePerMinute: number
  focusDecayPerMinute: number
}

/**
 * Defaults assume a desktop companion that runs all day.
 * A full battery of boredom takes about 40 minutes of silence.
 * A full battery of fatigue takes about 20 hours awake, so one workday fits.
 * A full night of rest clears a full battery of fatigue.
 */
export const defaultDriveConfig: DriveConfig = {
  fatiguePerMinute: 0.08,
  fatigueRecoverPerHour: 12.5,
  boredomPerMinute: 1.5,
  boredomReliefPerMinute: 3,
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

  const boredomGain = minutes * config.boredomPerMinute
  const boredomRelief = active ? minutes * config.boredomReliefPerMinute : 0
  const boredom = clamp(previous.boredom + boredomGain - boredomRelief, 0, 100)

  const curiosityDecay = Math.pow(0.5, Math.max(0, elapsedMs) / config.curiosityHalfLifeMs)
  const curiositySpike = signals.novelty ? config.curiositySpikeOnNovelty : 0
  const curiosity = clamp(previous.curiosity * curiosityDecay + curiositySpike, 0, 100)

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

export type MindAction = 'idle' | 'think' | 'provoke'

export interface ActionThresholds {
  /** Above this fatigue the companion rests instead of acting. */
  sleep: number
  /** Below this fatigue a resting companion can act again. */
  wake: number
  /** Boredom that makes the companion want to talk. */
  provoke: number
  /** Curiosity that makes the companion investigate. */
  think: number
}

export const defaultActionThresholds: ActionThresholds = {
  sleep: 80,
  wake: 55,
  provoke: 60,
  think: 55,
}

/**
 * Picks what the companion wants to do, before any gate applies.
 *
 * This is intent, not permission. The gates live in `planExpression`, which
 * decides whether the intent becomes speech, a bubble, or a held-back thought.
 * Mixing the two here made "wants to talk but is blocked" impossible.
 *
 * Fatigue still wins over every other drive: a tired companion wants nothing,
 * and rest is the only way back.
 */
export function decide(
  drives: Drives,
  thresholds: ActionThresholds = defaultActionThresholds,
): MindAction {
  if (drives.fatigue >= thresholds.sleep)
    return 'idle'
  if (drives.boredom >= thresholds.provoke)
    return 'provoke'
  if (drives.curiosity >= thresholds.think)
    return 'think'
  return 'idle'
}
