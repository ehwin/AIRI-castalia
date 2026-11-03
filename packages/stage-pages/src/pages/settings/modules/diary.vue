<script setup lang="ts">
import { useDiaryStore } from '@proj-airi/stage-ui/stores/modules/diary'
import { FieldCheckbox, GhostButton, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const diary = useDiaryStore()
const { byDay, loading, reveal, saidOutLoud, shared, lastDistilled } = storeToRefs(diary)

onMounted(() => {
  void diary.load()
})

const KEY = 'settings.pages.modules.diary'
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <SettingsCard>
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.summary`, { days: byDay.length, said: saidOutLoud }) }}
      </p>
      <p :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
        {{ t(`${KEY}.privacy`) }}
      </p>
    </SettingsCard>

    <SettingsCard>
      <FieldCheckbox
        v-model="reveal"
        :label="t(`${KEY}.reveal.label`)"
        :description="t(`${KEY}.reveal.description`)"
      />
      <p v-if="reveal" :class="['text-xs', 'text-amber-600 dark:text-amber-400']">
        {{ t(`${KEY}.reveal.warning`) }}
      </p>
    </SettingsCard>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:chat-round-dots-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1', 'truncate']">{{ t(`${KEY}.shared.title`) }}</span>
        <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">{{ shared.length }}</span>
      </h2>
      <p v-if="shared.length === 0" :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.shared.empty`) }}
      </p>
      <ul v-else :class="['flex flex-col', 'gap-2']">
        <li
          v-for="thought in shared"
          :key="thought.id"
          :class="['flex items-start', 'gap-3', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <span :class="['shrink-0', 'text-xs', 'text-neutral-400']">{{ clock(thought.at) }}</span>
          <span :class="['min-w-0 flex-1', 'text-sm', 'text-neutral-700 dark:text-neutral-200']">{{ thought.text }}</span>
        </li>
      </ul>
    </section>

    <p v-if="loading" :class="['text-sm', 'text-neutral-500']">
      {{ t(`${KEY}.loading`) }}
    </p>

    <SettingsCard v-else-if="byDay.length === 0">
      <p :class="['text-center', 'text-sm', 'text-neutral-500']">
        {{ t(`${KEY}.empty`) }}
      </p>
    </SettingsCard>

    <section
      v-for="day in byDay"
      v-else
      :key="day.date"
      :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']"
    >
      <h2 :class="['flex items-center', 'gap-2', 'text-sm font-medium']">
        <span :class="['i-solar:calendar-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
        <span :class="['min-w-0 flex-1', 'truncate']">{{ day.date }}</span>
        <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
          {{ t(`${KEY}.day-count`, { count: day.thoughts.length }) }}
        </span>
      </h2>

      <p v-if="!reveal" :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
        {{ t(`${KEY}.hidden`, { count: day.privateCount }) }}
      </p>

      <ul v-else :class="['flex flex-col', 'gap-2']">
        <li
          v-for="thought in day.thoughts"
          :key="thought.id"
          :class="['flex items-start', 'gap-3', 'rounded-lg', 'bg-white dark:bg-neutral-900/60', 'px-3 py-2.5']"
        >
          <span :class="['shrink-0', 'text-xs', 'text-neutral-400']">{{ clock(thought.at) }}</span>
          <span :class="['min-w-0 flex-1', 'text-sm', 'text-neutral-700 dark:text-neutral-200']">{{ thought.text }}</span>
        </li>
      </ul>

      <div :class="['flex', 'justify-end']">
        <GhostButton :label="diary.hasDistilled(day.date) ? t(`${KEY}.distilled`) : t(`${KEY}.distill`)" @click="diary.distill(day.date)" />
      </div>
    </section>
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
