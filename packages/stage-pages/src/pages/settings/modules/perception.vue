<script setup lang="ts">
import { usePerceptionStore } from '@proj-airi/stage-ui/stores/modules/perception'
import { FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const { screen, camera, screenReady, cameraReady } = storeToRefs(usePerceptionStore())
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['rounded-xl', 'bg-neutral-100 dark:bg-neutral-900', 'p-4', 'flex', 'flex-col', 'gap-4']">
      <FieldCheckbox
        v-model="screen"
        :label="t('settings.pages.modules.perception.enable-screen.label')"
        :description="t('settings.pages.modules.perception.enable-screen.description')"
        :disabled="!screenReady"
      />
      <p v-if="!screenReady" :class="['text-sm', 'text-amber-600 dark:text-amber-400']">
        {{ t('settings.pages.modules.perception.status.screen-missing') }}
      </p>

      <FieldCheckbox
        v-model="camera"
        :label="t('settings.pages.modules.perception.enable-camera.label')"
        :description="t('settings.pages.modules.perception.enable-camera.description')"
        :disabled="!cameraReady"
      />
      <p v-if="!cameraReady" :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.perception.status.camera-missing') }}
      </p>
    </div>

    <div :class="['rounded-xl', 'bg-neutral-50 dark:bg-neutral-800', 'p-4', 'flex', 'flex-col', 'gap-2']">
      <span :class="['text-sm', 'font-medium']">{{ t('settings.pages.modules.perception.status.title') }}</span>
      <span :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.perception.status.summary') }}
      </span>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.perception.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
