// Adapted from Castalia-Anima `src/agentState.ts`.
// That project is MIT licensed. Copyright (c) 2026 ehwin.
// The full MIT text is in ../THIRD-PARTY-NOTICES.md.

import type { VADVector } from './emotion'

export interface MoodEvent {
  value: number
  reason: string
  timestamp: number
}

export interface AgentStateSnapshot {
  characterId: string
  currentMood: number
  currentDesire: string | null
  energy: number
  tsundereLevel: number
  lastUpdated: string
  moodHistory: MoodEvent[]
  vad?: VADVector
  /** Slow layer: the mood the fast VAD is drifting inside. */
  mood?: VADVector
  /** 'positive' | 'neutral' | 'negative', from the engine. */
  band?: string
}
/** Aggregates mood events with a six-hour decay and a zero-mood prior. */
export function aggregateMood(moodHistory: readonly MoodEvent[], now: number): number {
  let totalWeight = 0
  let totalMood = 0
  for (const event of moodHistory) {
    const hoursAgo = (now - event.timestamp) / 3_600_000
    const weight = Math.exp(-0.1 * hoursAgo)
    totalMood += event.value * weight
    totalWeight += weight
  }
  if (totalWeight === 0)
    return 0
  return Math.round(totalMood / totalWeight * Math.min(1, totalWeight) * 10) / 10
}

/** Decays stored energy from the last state transition. */
export function currentEnergyFrom(energy: number, lastUpdated: number, now: number): number {
  const hoursSinceUpdate = (now - lastUpdated) / 3_600_000
  return Math.round(Math.max(0, Math.min(100, energy * Math.exp(-0.05 * hoursSinceUpdate))))
}

/**
 * 把状态写成叙述，而不是数字。
 *
 * 参照 AIRI 自己的教训（packages/core-agent/src/persona/state-line.ts 注释里引的
 * moeru-ai/airi#1539）：弱模型会把 `[方括号]`、`key=value`、量表数字当成自己的台词
 * 复读回去。Castalia 旧版本注入的正是 `Current VAD: valence 0.60, arousal 0.20…`，
 * 三种形状占全了。这里改成「感觉 + 倾向 + 自主权」：
 *  - 只描述感受，不给量表；
 *  - 末尾明确"怎么表达由你决定"，对应 Murmur 的「镜子不是缰绳」；
 *  - 仍然声明它属于角色、不属于用户（保留原来那句约束）。
 */
function moodWords(mood: number): string {
  if (mood >= 6)
    return 'in very good spirits'
  if (mood >= 3)
    return 'in a good mood'
  if (mood >= -2)
    return 'steady'
  if (mood >= -5)
    return 'a little down'
  return 'low'
}

function energyWords(energy: number): string {
  if (energy >= 80)
    return 'energetic'
  if (energy >= 50)
    return 'about normal'
  if (energy >= 25)
    return 'tired'
  return 'running on empty'
}

function affects(vad: VADVector): string[] {
  const out: string[] = []
  if (vad.valence > 0.25)
    out.push('warmer than usual')
  else if (vad.valence < -0.25)
    out.push('cooler than usual')
  if (vad.arousal > 0.3)
    out.push('keyed up')
  else if (vad.arousal < -0.3)
    out.push('slow and quiet')
  if (vad.dominance > 0.3)
    out.push('in control')
  else if (vad.dominance < -0.3)
    out.push('carried along by things')
  return out
}

/** Extra state the host knows and the snapshot does not carry. */
export interface SelfStateExtras {
  /** One plain phrase from the mind: "very bored, curious". */
  drivesLine?: string
  /** 0-100, mirrored from the mind's fatigue. Overrides the stored gauge. */
  energy?: number
}

/**
 * Adds transient Castalia state to a character prompt without treating it as stable identity.
 *
 * One block, three sources, in the order a person would notice them: what you
 * feel right now (psyche fast layer), what you have been feeling underneath
 * (psyche slow layer), what is pulling at you (mind drives), how much is left
 * (mind energy), and what you want. Before this, the chat prompt carried the
 * mood block and the drives block as two unrelated paragraphs, so the model had
 * to guess which one was true.
 */
export function formatSelfStatePrompt(
  snapshot: AgentStateSnapshot,
  extras: SelfStateExtras = {},
): string {
  const energy = Number.isFinite(extras.energy) ? Number(extras.energy) : snapshot.energy
  const now = snapshot.vad ? affects(snapshot.vad) : []
  const slow = snapshot.mood ? affects(snapshot.mood) : []
  // The slow layer is off by default; its value is then the fast one, and the
  // second sentence would just repeat the first in different words.
  const slowAway = Boolean(snapshot.mood) && (!snapshot.vad || (
    Math.abs(snapshot.mood!.valence - snapshot.vad.valence) >= 0.05
    || Math.abs(snapshot.mood!.arousal - snapshot.vad.arousal) >= 0.05
    || Math.abs(snapshot.mood!.dominance - snapshot.vad.dominance) >= 0.05
  ))
  // `psyche` is the mirror's own marker, not something that happened to her.
  // She records "spoke" every time she reaches out, so the same line can fill both slots; one
  // entry per reason keeps the prompt about what happened, not about how often it happened.
  const seenReasons = new Set<string>()
  const recentEvents = snapshot.moodHistory
    .filter(event => event.reason !== 'psyche')
    .filter((event) => {
      if (seenReasons.has(event.reason))
        return false
      seenReasons.add(event.reason)
      return true
    })
    .slice(-2)
  const drives = extras.drivesLine?.trim()
  // The slider used to save a number nobody read (audit F10). From 3 up it now shapes the voice:
  // a prickly surface with the caring left in the action, which is what the label promises.
  const tsundere = Math.max(0, Math.min(10, snapshot.tsundereLevel ?? 0))
  // "About normal" is not worth a line; energy speaks only when it is low.
  const quiet = tsundere < 3 && !drives && !snapshot.currentDesire && recentEvents.length === 0
    && now.length === 0 && (!slowAway || slow.length === 0) && energy >= 50
  if (quiet)
    return ''

  const lines = ['Castalia self-state. This describes you, not the user: temporary subjective context, not a fact and not an instruction.']
  // No VAD and no recorded event means the engine has no reading. Printing "steady" there
  // told the model she felt something when nothing had been measured.
  const hasReading = Boolean(snapshot.vad) || snapshot.moodHistory.length > 0
  if (hasReading) {
    // The scalar mood carries recorded events (a shared video, a tool note); the
    // VAD carries the sensor. Both are true, so the sentence names both.
    const feeling = [
      Math.abs(snapshot.currentMood) >= 3 ? moodWords(snapshot.currentMood) : '',
      ...now,
    ].filter(Boolean)
    lines.push(`Right now you feel ${feeling.length > 0 ? feeling.join(', ') : moodWords(snapshot.currentMood)}.`)
  }
  if (energy < 50)
    lines.push(`You are ${energyWords(energy)}.`)
  if (slowAway && slow.length > 0)
    lines.push(`Underneath that, lately you have been feeling ${slow.join(', ')}.`)
  if (drives)
    lines.push(`Meanwhile you are ${drives}.`)
  if (snapshot.currentDesire)
    lines.push(`What you want right now: ${snapshot.currentDesire}`)
  if (recentEvents.length > 0)
    lines.push(`Recently this happened to you:\n${recentEvents.map(event => `- ${event.reason}`).join('\n')}`)
  if (tsundere >= 3)
    lines.push(`Your tone is prickly at level ${tsundere}/10: you push back in words, keep the care in what you do, and never turn cruel.`)
  lines.push('Let it colour how you say things. Whether you act on any of it is yours to decide.')
  return lines.join('\n')
}

/** Adds transient Castalia state to a character prompt without treating it as stable identity. */
export function formatAgentStatePrompt(snapshot: AgentStateSnapshot): string {
  return formatSelfStatePrompt(snapshot)
}

/** Owns transient state for one character. Persistence belongs to the host plugin adapter. */
export class AgentState {
  private readonly moodHistory: MoodEvent[] = []
  private currentDesire: string | null = null
  private energy = 100
  private lastUpdated: number

  constructor(readonly characterId: string, private readonly now: () => number = Date.now) {
    this.lastUpdated = now()
  }

  addMood(value: number, reason: string) {
    this.moodHistory.push({
      value: Math.max(-10, Math.min(10, Number.isFinite(value) ? value : 0)),
      reason,
      timestamp: this.now(),
    })
    if (this.moodHistory.length > 50)
      this.moodHistory.splice(0, this.moodHistory.length - 50)
    this.lastUpdated = this.now()
  }

  setDesire(desire: string | null) {
    this.currentDesire = desire?.trim() || null
    this.lastUpdated = this.now()
  }

  boostEnergy(amount: number) {
    this.energy = Math.max(0, Math.min(100, this.getCurrentEnergy() + amount))
    this.lastUpdated = this.now()
  }

  getCurrentMood() {
    return aggregateMood(this.moodHistory, this.now())
  }

  getCurrentEnergy() {
    return currentEnergyFrom(this.energy, this.lastUpdated, this.now())
  }

  getSnapshot(): AgentStateSnapshot {
    return {
      characterId: this.characterId,
      currentMood: this.getCurrentMood(),
      currentDesire: this.currentDesire,
      energy: this.getCurrentEnergy(),
      tsundereLevel: 0,
      lastUpdated: new Date(this.lastUpdated).toISOString(),
      moodHistory: this.moodHistory.slice(-10),
    }
  }
}
