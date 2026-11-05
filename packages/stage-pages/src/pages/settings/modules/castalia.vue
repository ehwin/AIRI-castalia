<script setup lang="ts">
import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { FieldCheckbox, FieldRange, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const castalia = useCastaliaPluginStore()
const cards = useAiriCardStore()
const { enabled, currentMood, currentDesire, currentEnergy, activeCharacterId, moodHistory } = storeToRefs(castalia)
const { t } = useI18n()
// The newest five events are the short-term memory the next prompt carries.
// `psyche` is the mirror's own marker, not an event she lived through.
const recentMoodEvents = computed(() => moodHistory.value.filter(event => event.reason !== 'psyche').slice(-5).reverse())
// Zero is "steady". Having no reading is a different answer, and the panel used to print both as 0.
const moodKnown = computed(() =>
  Boolean(castalia.snapshotFor(activeCharacterId.value).vad) || moodHistory.value.length > 0)
watch(() => cards.activeCardId, characterId => castalia.setCharacter(characterId), { immediate: true })
</script>

<template>
  <SettingsCard>
    <div class="flex flex-col gap-4">
      <FieldCheckbox
        v-model="enabled"
        :label="t('settings.pages.modules.castalia.enable')"
        :description="t('settings.pages.modules.castalia.enable-description')"
      />
      <FieldRange
        :model-value="castalia.snapshotFor(activeCharacterId).tsundereLevel"
        :label="t('settings.pages.modules.castalia.tsundere-level')"
        :description="t('settings.pages.modules.castalia.tsundere-level-description')"
        :min="0"
        :max="10"
        :step="1"
        @update:model-value="castalia.setTsundereLevel($event, activeCharacterId)"
      />
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="text-sm text-neutral-500">
            {{ t('settings.pages.modules.castalia.mood') }}
          </div>
          <div class="text-xl font-medium">
            <template v-if="moodKnown">
              {{ currentMood }}
            </template>
            <span v-else class="text-base text-neutral-400 font-normal">
              {{ t('settings.pages.modules.castalia.no-mood-evidence') }}
            </span>
          </div>
        </div>
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="text-sm text-neutral-500">
            {{ t('settings.pages.modules.castalia.desire') }}
          </div>
          <div class="text-base font-medium">
            {{ currentDesire || t('settings.pages.modules.castalia.no-desire') }}
          </div>
        </div>
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="text-sm text-neutral-500">
            {{ t('settings.pages.modules.castalia.energy') }}
          </div>
          <div class="text-xl font-medium">
            {{ currentEnergy }}%
          </div>
        </div>
      </div>
      <p class="text-sm text-neutral-500">
        {{ t('settings.pages.modules.castalia.status-description') }}
      </p>
      <div class="flex flex-col gap-2">
        <div class="text-sm font-medium">
          {{ t('settings.pages.modules.castalia.short-term-memory') }}
        </div>
        <p class="text-xs text-neutral-500">
          {{ t('settings.pages.modules.castalia.short-term-memory-description') }}
        </p>
        <ul v-if="recentMoodEvents.length" class="flex flex-col gap-1">
          <li
            v-for="event in recentMoodEvents"
            :key="`${event.timestamp}-${event.reason}`"
            class="flex items-baseline justify-between gap-3 rounded-md bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800"
          >
            <span class="truncate">{{ event.reason }}</span>
            <span class="shrink-0 text-neutral-500">{{ event.value > 0 ? '+' : '' }}{{ event.value }}</span>
          </li>
        </ul>
        <p v-else class="text-sm text-neutral-500">
          {{ t('settings.pages.modules.castalia.no-short-term-memory') }}
        </p>
      </div>
    </div>
  </SettingsCard>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.castalia.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
