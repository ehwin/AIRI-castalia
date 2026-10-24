<script setup lang="ts">
import { useDiaryStore } from '@proj-airi/stage-ui/stores/modules/diary'
import { FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const diary = useDiaryStore()
const { byDay, loading, reveal, saidOutLoud, shared, lastDistilled } = storeToRefs(diary)

onMounted(() => {
  void diary.load()
})

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-4']">
    <div :class="['rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4', 'flex', 'flex-col', 'gap-1']">
      <span :class="['text-sm', 'text-neutral-600 dark:text-neutral-300']">
        {{ t('settings.pages.modules.diary.summary', { days: byDay.length, said: saidOutLoud }) }}
      </span>
      <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.diary.privacy') }}
      </span>
    </div>

    <div :class="['rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4', 'flex', 'flex-col', 'gap-2']">
      <FieldCheckbox
        v-model="reveal"
        :label="t('settings.pages.modules.diary.reveal.label')"
        :description="t('settings.pages.modules.diary.reveal.description')"
      />
      <p v-if="reveal" :class="['text-xs', 'text-amber-600 dark:text-amber-400']">
        {{ t('settings.pages.modules.diary.reveal.warning') }}
      </p>
    </div>

    <div :class="['flex', 'flex-col', 'gap-2']">
      <span :class="['text-sm', 'font-medium']">{{ t('settings.pages.modules.diary.shared.title') }}</span>
      <div v-if="shared.length === 0" :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.diary.shared.empty') }}
      </div>
      <div v-for="thought in shared" :key="thought.id" :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'px-3', 'py-2', 'flex', 'gap-3']">
        <span :class="['text-xs', 'text-neutral-400', 'shrink-0']">{{ clock(thought.at) }}</span>
        <span :class="['text-sm', 'text-neutral-700 dark:text-neutral-200']">{{ thought.text }}</span>
      </div>
    </div>

    <div v-if="loading" :class="['text-sm', 'text-neutral-500']">
      {{ t('settings.pages.modules.diary.loading') }}
    </div>

    <div v-else-if="byDay.length === 0" :class="['rounded-xl', 'bg-neutral-50 dark:bg-neutral-800', 'p-6', 'text-center', 'text-sm', 'text-neutral-500']">
      {{ t('settings.pages.modules.diary.empty') }}
    </div>

    <div v-for="day in byDay" v-else :key="day.date" :class="['flex', 'flex-col', 'gap-2']">
      <div :class="['flex', 'items-center', 'gap-3']">
        <span :class="['text-sm', 'font-medium']">{{ day.date }}</span>
        <span :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.diary.day-count', { count: day.thoughts.length }) }}
        </span>
        <button
          :class="['ml-auto', 'rounded-lg', 'px-3', 'py-1', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700', 'transition-colors']"
          @click="diary.distill(day.date)"
        >
          {{ lastDistilled === day.date ? t('settings.pages.modules.diary.distilled') : t('settings.pages.modules.diary.distill') }}
        </button>
      </div>

      <div v-if="!reveal" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.diary.hidden', { count: day.privateCount }) }}
      </div>

      <div v-else :class="['flex', 'flex-col', 'gap-1']">
        <div
          v-for="thought in day.thoughts"
          :key="thought.id"
          :class="['rounded-lg', 'bg-neutral-50 dark:bg-neutral-800', 'px-3', 'py-2', 'flex', 'gap-3']"
        >
          <span :class="['text-xs', 'text-neutral-400', 'shrink-0']">{{ clock(thought.at) }}</span>
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
