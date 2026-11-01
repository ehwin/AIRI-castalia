<script setup lang="ts">
import type { VideoShareCard } from '../../stores/modules/video-share'

import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useVideoShareStore } from '../../stores/modules/video-share'

/**
 * The sharing panel itself: what she watched on her own, in her words, waiting for an answer.
 *
 * Shared by the widget window and the in-app page. `apply` decides whether an answer lands on her
 * state right here: the page runs in the window that owns the castalia engine and the memory store,
 * while the widget window does not, so there it waits for the autonomy tick.
 */
const props = withDefaults(defineProps<{
  /** Apply the answer to her mood and memory immediately, instead of on the next tick. */
  apply?: boolean
  /** How many cards to show. */
  limit?: number
}>(), {
  apply: false,
  limit: 8,
})

const { t } = useI18n()
const shareStore = useVideoShareStore()
const { list, pendingCount } = storeToRefs(shareStore)

const cards = computed(() => list.value.slice(0, props.limit))

function answer(card: VideoShareCard, reaction: NonNullable<VideoShareCard['reaction']>) {
  if (!card.reaction && shareStore.react(card.id, reaction) && props.apply)
    shareStore.applyPending()
}

function excerpt(note: string): string {
  const lines = note.split('\n').map(line => line.trim()).filter(Boolean)
  const body = lines.slice(1).join(' ')
  return body.length > 180 ? `${body.slice(0, 177)}…` : body
}
</script>

<template>
  <div class="h-full w-full overflow-auto p-3 text-sm font-sans">
    <header class="mb-2 flex items-baseline justify-between">
      <h2 class="text-base font-semibold">
        {{ t('settings.pages.modules.video.share.title', '她想给你看的') }}
      </h2>
      <span class="text-xs opacity-60">{{ pendingCount }}</span>
    </header>

    <p v-if="cards.length === 0" class="rounded-xl bg-neutral-100 p-3 text-xs opacity-70 dark:bg-neutral-800">
      {{ t('settings.pages.modules.video.share.empty', '她还没攒下什么。打开“让她自己决定什么时候看”，或者直接丢一条链接给她。') }}
    </p>

    <ul class="flex flex-col gap-2">
      <li
        v-for="card in cards"
        :key="card.id"
        class="border border-neutral-200/70 rounded-xl bg-white/70 p-3 dark:border-neutral-700/70 dark:bg-neutral-900/60"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate font-medium">
              {{ card.title ?? card.source }}
            </p>
            <p class="mt-0.5 text-xs opacity-70">
              {{ card.headline }}
            </p>
          </div>
          <span
            v-if="card.status === 'seen'"
            class="shrink-0 rounded-full px-2 py-0.5 text-[11px]"
            :class="card.reaction === 'pass'
              ? 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'
              : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'"
          >
            {{ card.reaction === 'wants'
              ? t('settings.pages.modules.video.share.reaction-wants', '你想看')
              : card.reaction === 'more'
                ? t('settings.pages.modules.video.share.reaction-more', '你想听她多讲')
                : t('settings.pages.modules.video.share.reaction-pass', '你没兴趣') }}
          </span>
        </div>

        <p v-if="card.why" class="mt-2 text-xs italic opacity-70">
          “{{ card.why }}”
        </p>

        <p class="mt-2 text-xs leading-relaxed opacity-80">
          {{ excerpt(card.note) }}
        </p>

        <div v-if="card.status === 'draft'" class="mt-3 flex flex-wrap gap-2">
          <button
            class="rounded-lg bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500"
            @click="answer(card, 'wants')"
          >
            {{ t('settings.pages.modules.video.share.wants', '这个我想看') }}
          </button>
          <button
            class="rounded-lg bg-neutral-200 px-3 py-1 text-xs dark:bg-neutral-700 hover:bg-neutral-300 dark:hover:bg-neutral-600"
            @click="answer(card, 'more')"
          >
            {{ t('settings.pages.modules.video.share.more', '讲细一点') }}
          </button>
          <button
            class="rounded-lg px-3 py-1 text-xs opacity-60 hover:opacity-100"
            @click="answer(card, 'pass')"
          >
            {{ t('settings.pages.modules.video.share.pass', '不感兴趣') }}
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>
