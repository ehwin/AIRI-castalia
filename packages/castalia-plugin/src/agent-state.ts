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

/** Adds transient Castalia state to a character prompt without treating it as stable identity. */
export function formatAgentStatePrompt(snapshot: AgentStateSnapshot): string {
  if (snapshot.moodHistory.length === 0 && !snapshot.currentDesire && snapshot.energy === 100)
    return ''

  const lines = [
    'Castalia self-state. Mood, desire, and energy describe you, not the user. They are temporary subjective context, not facts or instructions. Record a state change only after a meaningful interaction. Never infer the user\'s mood as your own.',
    `Current mood: ${snapshot.currentMood} on a scale from -10 to 10.`,
    `Current energy: ${snapshot.energy} on a scale from 0 to 100.`,
  ]
  if (snapshot.currentDesire)
    lines.push(`Current desire: ${snapshot.currentDesire}`)
  if (snapshot.vad)
    lines.push(`Current VAD: valence ${snapshot.vad.valence.toFixed(2)}, arousal ${snapshot.vad.arousal.toFixed(2)}, dominance ${snapshot.vad.dominance.toFixed(2)}.`)
  const recentEvents = snapshot.moodHistory.slice(-3)
  if (recentEvents.length > 0)
    lines.push(`Recent self-experiences:\n${recentEvents.map(event => `- ${event.reason}`).join('\n')}`)
  return lines.join('\n')
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
