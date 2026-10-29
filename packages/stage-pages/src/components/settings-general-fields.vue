<script setup lang="ts">
import { all } from '@proj-airi/i18n'
import { useSettings } from '@proj-airi/stage-ui/stores/settings'
import { FieldCheckbox, FieldCombobox, useTheme } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = withDefaults(defineProps<{
  needsControlsIslandIconSizeSetting?: boolean
}>(), {
  needsControlsIslandIconSizeSetting: import.meta.env.RUNTIME_ENVIRONMENT === 'electron',
})

const settings = useSettings()
const showStreamerMode = import.meta.env.RUNTIME_ENVIRONMENT === 'electron'

const showControlsIsland = computed(() => props.needsControlsIslandIconSizeSetting)

const { t } = useI18n()
const { themeMode } = useTheme()

const languages = computed(() => {
  return Object.entries(all).map(([value, label]) => ({ value, label }))
})
</script>

<template>
  <div class="flex flex-col gap-4 rounded-lg bg-neutral-50 p-4 dark:bg-neutral-800">
    <FieldCombobox
      v-model="themeMode"
      v-motion
      :class="['mb-2']"
      :initial="{ opacity: 0, y: 10 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="250 + (2 * 10)"
      :delay="2 * 50"
      :label="t('settings.theme.title')"
      :description="t('settings.theme.description')"
      :options="[
        { value: 'auto', label: t('settings.theme.auto') },
        { value: 'light', label: t('settings.theme.light') },
        { value: 'dark', label: t('settings.theme.dark') },
      ]"
    />

    <FieldCombobox
      v-model="settings.language"
      v-motion
      :initial="{ opacity: 0, y: 10 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="250 + (3 * 10)"
      :delay="3 * 50"
      :class="['transition-all', 'ease-in-out', 'duration-250']"
      :label="t('settings.language.title')"
      :description="t('settings.language.description')"
      layout="horizontal"
      :options="languages"
    />

    <FieldCombobox
      v-if="showControlsIsland"
      v-model="settings.controlsIslandIconSize"
      v-motion
      :initial="{ opacity: 0, y: 10 }"
      :enter="{ opacity: 1, y: 0 }"
      :duration="250 + (4 * 10)"
      :delay="4 * 50"
      :class="['transition-all', 'ease-in-out', 'duration-250']"
      :label="t('settings.controls-island.icon-size.title')"
      :description="t('settings.controls-island.icon-size.description')"
      :options="[
        { value: 'auto', label: t('settings.controls-island.icon-size.auto') },
        { value: 'large', label: t('settings.controls-island.icon-size.large') },
        { value: 'small', label: t('settings.controls-island.icon-size.small') },
      ]"
    />

    <FieldCheckbox
      v-if="showStreamerMode"
      v-model="settings.streamerMode"
      :label="t('settings.streamer-mode.title')"
      :description="t('settings.streamer-mode.description')"
    />

    <slot name="additional-fields" />

    <div
      v-motion
      :class="['text-neutral-200/50', 'dark:text-neutral-600/20', 'pointer-events-none', 'fixed', 'top-[65dvh]', 'right--15', 'z--1', 'flex', 'items-center', 'justify-center']"
      :initial="{ scale: 0.9, opacity: 0, rotate: 30 }"
      :enter="{ scale: 1, opacity: 1, rotate: 0 }"
      :duration="250"
    >
      <div :class="['text-60', 'i-solar:emoji-funny-square-bold-duotone']" />
    </div>
  </div>
</template>
