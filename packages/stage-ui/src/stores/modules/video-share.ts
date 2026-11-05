import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useMemoryStore } from '../memory'
import { useAiriCardStore } from './airi-card'

/**
 * What she wants to show you, and what you thought of it.
 *
 * The loop is the point: she watches something on her own, puts a card up, and your tap comes back
 * as a mood change plus a memory line. A share nobody can answer teaches her nothing, and a panel
 * that only lists her queue is a log, not a habit.
 *
 * The tap itself is only recorded here. The mood and memory side effects are applied by the window
 * that owns the castalia engine and the memory store (see `applyFeedback` in the autonomy store):
 * the panel lives in its own renderer, and a mood change written from there would land nowhere.
 *
 * What the card holds is the digest she wrote, so a reaction answers a real clip at a real
 * timestamp — never a promise that she will "watch it later".
 */
export interface VideoShareCard {
  id: string
  /** Bilibili id or link, direct URL, or path. */
  source: string
  title?: string
  /** One line she chose, in her own voice, to make you look. */
  headline: string
  /** Why she queued it in the first place. */
  why: string
  /** Her digest: transcript excerpt, or the sheet timecodes. */
  note: string
  at: number
  /** `draft` waits for you; `seen` means you already answered. */
  status: 'draft' | 'seen'
  reaction?: 'wants' | 'more' | 'pass'
  reactedAt?: number
  /** `true` once the answer has reached her mood and her memory. */
  applied?: boolean
}

/** What a tap means to her, in mood points and words. */
export function feedbackEffect(reaction: NonNullable<VideoShareCard['reaction']>): { mood: number, reason: string } {
  if (reaction === 'wants')
    return { mood: 2, reason: '主人点开了我分享的视频' }
  if (reaction === 'more')
    return { mood: 1, reason: '主人想听我多讲一点' }
  return { mood: -1, reason: '主人对我分享的东西没兴趣' }
}

/** Old cards are dropped first: the panel is a window on what is recent, not an archive. */
const KEEP = 30

function newId(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
}

export const useVideoShareStore = defineStore('video-share', () => {
  // Resolved lazily, on the one call that needs them: creating this store should not drag the card
  // store's i18n setup (or the engine) into a window that only draws a list.
  const cards = useLocalStorageManualReset<VideoShareCard[]>('video-share/cards', [])

  /** Newest first: what she just watched is what she is most eager about. */
  const list = computed(() => [...cards.value].sort((a, b) => b.at - a.at))
  const drafts = computed(() => list.value.filter(card => card.status === 'draft'))
  const pendingCount = computed(() => drafts.value.length)
  /** Answers that have not reached her mood and memory yet. */
  const unapplied = computed(() => list.value.filter(card => card.reaction && !card.applied))

  /**
   * Puts a watched clip on the panel.
   *
   * The same source within a day replaces its earlier card rather than stacking: she should not
   * ping the owner three times about one video.
   */
  function publish(input: { source: string, title?: string, headline: string, why: string, note: string }): VideoShareCard | undefined {
    const source = input.source.trim()
    if (!source || !input.note.trim())
      return undefined

    const dayStart = new Date().setHours(0, 0, 0, 0)
    const duplicate = cards.value.find(card => card.source === source && card.at >= dayStart)
    const card: VideoShareCard = duplicate
      ? { ...duplicate, at: Date.now(), note: input.note, headline: input.headline, why: input.why, status: 'draft', title: input.title ?? duplicate.title }
      : { id: newId(), source, at: Date.now(), headline: input.headline, why: input.why, note: input.note, status: 'draft', ...(input.title ? { title: input.title } : {}) }

    cards.value = [card, ...cards.value.filter(existing => existing.id !== card.id)]
      .sort((a, b) => b.at - a.at)
      .slice(0, KEEP)
    return card
  }

  /**
   * Records your answer. Deliberately side-effect free beyond the card: the mood and memory writes
   * happen in the window that owns those stores, on its next tick.
   */
  function react(id: string, reaction: VideoShareCard['reaction']) {
    const card = cards.value.find(entry => entry.id === id)
    if (!card || !reaction || card.status === 'seen')
      return undefined

    const next: VideoShareCard = { ...card, status: 'seen', reaction, reactedAt: Date.now(), applied: false }
    cards.value = cards.value.map(entry => entry.id === id ? next : entry)
    return next
  }

  /** Marks an answer as delivered, so a tick never applies it twice. */
  function markApplied(id: string) {
    cards.value = cards.value.map(entry => entry.id === id ? { ...entry, applied: true } : entry)
  }

  /**
   * Delivers every unanswered tap to her mood and her memory.
   *
   * Safe to call from both the panel and the autonomy tick: `applied` makes it idempotent, and a
   * write that throws is retried next tick instead of being silently counted.
   */
  function applyPending() {
    for (const card of unapplied.value) {
      const { mood, reason } = feedbackEffect(card.reaction!)
      try {
        const memory = useMemoryStore()
        const cardId = useAiriCardStore().activeCardId
        // The bank keys rows by persona, not by card id, and the mood and the entry must land on
        // the same key the chat writes to (audit F01).
        const persona = memory.enabled ? memory.resolvePersona(cardId) : cardId
        // The module switch gates her state, the same way it gates self-initiated speech. The
        // memory write keeps its own switch: a reaction can be remembered while the state is frozen.
        const castalia = useCastaliaPluginStore()
        if (castalia.enabled)
          castalia.recordMood(mood, reason, persona)
        memory.write({
          name: `分享过的片子 ${(card.title ?? card.source).slice(0, 36)}`,
          description: `我主动分享给主人的一条视频，主人的反应：${card.reaction}`,
          body: `${card.headline} — ${card.note}`,
        }, persona)
        markApplied(card.id)
      }
      catch (error) {
        console.warn('[video] could not deliver the answer to her state:', error)
        return
      }
    }
  }

  /** One line a panel can show as the summary of what she watched. */
  function headlineFor(note: string): string {
    const line = note.split('\n').find(entry => entry.trim().length > 0) ?? ''
    return line.length > 120 ? `${line.slice(0, 117)}…` : line
  }

  function resetState() {
    cards.reset()
  }

  return {
    cards,
    list,
    drafts,
    pendingCount,
    unapplied,
    publish,
    react,
    markApplied,
    applyPending,
    headlineFor,
    resetState,
  }
})
