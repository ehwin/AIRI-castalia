<script setup lang="ts">
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useThoughtsStore } from '@proj-airi/stage-ui/stores/modules/thoughts'
import { FieldCheckbox, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const store = useThoughtsStore()
const memory = useMemoryStore()
const { byDay, error, loading, total } = storeToRefs(store)
// Off by default, like the diary: reading the raw stream every day turns it into a feed.
const reveal = useLocalStorageManualReset<boolean>('thoughts/reveal', false)

onMounted(() => {
  void store.load()
})

const KEY = 'settings.pages.modules.thoughts'
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <SettingsCard>
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.summary`, { days: byDay.length, lines: total }) }}
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

    <SettingsCard v-if="!memory.thoughtsSupported">
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.unsupported`) }}
      </p>
    </SettingsCard>

    <SettingsCard v-else-if="error">
      <p :class="['text-sm', 'text-red-500 dark:text-red-400']">
        {{ t(`${KEY}.unreadable`, { reason: error }) }}
      </p>
    </SettingsCard>

    <p v-else-if="loading" :class="['text-sm', 'text-neutral-500']">
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
        <span :class="['i-solar:cloud-file-bold-duotone', 'text-lg', 'text-primary-500 dark:text-primary-400']" aria-hidden="true" />
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
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.thoughts.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
