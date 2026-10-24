<script setup lang="ts">
import { useDiaryStore } from '@proj-airi/stage-ui/stores/modules/diary'
import { storeToRefs } from 'pinia'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const diary = useDiaryStore()
const { byDay, loading, saidOutLoud } = storeToRefs(diary)

onMounted(() => {
  void diary.load()
})

const timeOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4', 'flex', 'flex-col', 'gap-1']">
      <span :class="['text-sm', 'text-neutral-600 dark:text-neutral-300']">
        {{ t('settings.pages.modules.diary.summary', { days: byDay.length, said: saidOutLoud }) }}
      </span>
      <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.diary.privacy') }}
      </span>
    </div>

    <div v-if="loading" :class="['text-sm', 'text-neutral-500']">
      {{ t('settings.pages.modules.diary.loading') }}
    </div>

    <div v-else-if="byDay.length === 0" :class="['rounded-xl', 'bg-neutral-50 dark:bg-neutral-800', 'p-6', 'text-center', 'text-sm', 'text-neutral-500']">
      {{ t('settings.pages.modules.diary.empty') }}
    </div>

    <div v-for="day in byDay" v-else :key="day.date" :class="['flex', 'flex-col', 'gap-2']">
      <div :class="['flex', 'items-baseline', 'gap-2']">
        <span :class="['text-sm', 'font-medium']">{{ day.date }}</span>
        <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.diary.day-count', { count: day.thoughts.length }) }}
        </span>
      </div>
      <div :class="['flex', 'flex-col', 'gap-1']">
        <div
          v-for="thought in day.thoughts"
          :key="thought.id"
          :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'px-3', 'py-2', 'flex', 'gap-3']"
        >
          <span :class="['text-xs', 'text-neutral-400', 'shrink-0']">{{ timeOf(thought.at) }}</span>
          <span :class="['text-sm', 'text-neutral-700 dark:text-neutral-200']">{{ thought.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.diary.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
