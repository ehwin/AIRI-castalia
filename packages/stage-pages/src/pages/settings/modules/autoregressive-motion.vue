<script setup lang="ts">
import { useLive2DMotionMagicSettings } from '@proj-airi/stage-ui/features/motions/live2d'
import { FieldRange, FieldSelect, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const settings = useLive2DMotionMagicSettings()
const { method, arHmmNoiseScale, arHmmOrder, arHmmStateCount } = storeToRefs(settings)
const { t } = useI18n()
const methodOptions = [
  { label: 'VAR', value: 'var' },
  { label: 'AR-HMM', value: 'ar-hmm' },
]
</script>

<template>
  <SettingsCard>
    <div class="flex flex-col gap-4">
      <FieldSelect
        v-model="method"
        :label="t('settings.pages.modules.autoregressive-motion.method')"
        :description="t('settings.pages.modules.autoregressive-motion.method-description')"
        :options="methodOptions"
      />
      <template v-if="method === 'ar-hmm'">
        <FieldRange
          v-model="arHmmStateCount"
          :label="t('settings.pages.modules.autoregressive-motion.states')"
          :description="t('settings.pages.modules.autoregressive-motion.states-description')"
          :min="2"
          :max="12"
          :step="1"
        />
        <FieldRange
          v-model="arHmmOrder"
          :label="t('settings.pages.modules.autoregressive-motion.order')"
          :description="t('settings.pages.modules.autoregressive-motion.order-description')"
          :min="1"
          :max="24"
          :step="1"
        />
        <FieldRange
          v-model="arHmmNoiseScale"
          :label="t('settings.pages.modules.autoregressive-motion.noise')"
          :description="t('settings.pages.modules.autoregressive-motion.noise-description')"
          :min="0"
          :max="2"
          :step="0.1"
        />
      </template>
      <p class="text-sm text-neutral-500">
        {{ t('settings.pages.modules.autoregressive-motion.activation') }}
      </p>
    </div>
  </SettingsCard>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.autoregressive-motion.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
