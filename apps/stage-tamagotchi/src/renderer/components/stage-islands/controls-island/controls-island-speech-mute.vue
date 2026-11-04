<script setup lang="ts">
import { useStopSpeakingButton } from '@proj-airi/stage-layouts/composables/useStopSpeakingButton'
import { useRemoteStageStore } from '@proj-airi/stage-ui/stores/remote-stage'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import ControlButtonTooltip from './control-button-tooltip.vue'
import ControlButton from './control-button.vue'

defineProps<{
  buttonStyle: string
  iconClass: string
}>()

const { t } = useI18n()
const { speechMuted, toggleSpeechMuted } = useStopSpeakingButton()
const remoteStage = useRemoteStageStore()

// Muting also publishes a stop request, so it clears the queued and the
// playing speech on its way.
const label = computed(() => speechMuted.value
  ? t('tamagotchi.stage.controls-island.unmute')
  : t('tamagotchi.stage.controls-island.mute'))

// Asking this machine to speak by hand supersedes the handover to a connected device, otherwise the next
// registry event would silence it again.
function handleClick() {
  toggleSpeechMuted()
  if (!speechMuted.value)
    remoteStage.setRemoteVoicePreferred(false)
}
</script>

<template>
  <ControlButtonTooltip side="inward" as-child>
    <ControlButton
      :button-style
      :aria-label="label"
      :aria-pressed="speechMuted"
      @click="handleClick"
    >
      <div
        v-if="speechMuted"
        :class="[
          iconClass,
          'i-solar:volume-cross-outline',
          'text-neutral-800 dark:text-neutral-300',
        ]"
      />
      <div
        v-else
        :class="[
          iconClass,
          'i-solar:volume-loud-outline',
          'text-neutral-800 dark:text-neutral-300',
        ]"
      />
    </ControlButton>
    <template #tooltip>
      {{ label }}
    </template>
  </ControlButtonTooltip>
</template>
