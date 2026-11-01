<script setup lang="ts">
import { Callout, FieldCheckbox, FieldInput, FieldSelect, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useVideoStore } from '../../stores/modules/video'

const { t } = useI18n()
const videoStore = useVideoStore()
const { enabled, depth, attachImages, bilibiliCookie, autonomous, configured, runtimeAvailable } = storeToRefs(videoStore)

const depthOptions = computed(() => [
  { label: t('settings.pages.modules.video.depth.skim'), value: 'skim' },
  { label: t('settings.pages.modules.video.depth.read'), value: 'read' },
  { label: t('settings.pages.modules.video.depth.deep'), value: 'deep' },
])
</script>

<template>
  <SettingsCard>
    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.modules.video.enable')"
      :description="t('settings.pages.modules.video.enable-description')"
    />

    <FieldSelect
      v-model="depth"
      :label="t('settings.pages.modules.video.depth.label')"
      :description="t('settings.pages.modules.video.depth.description')"
      :options="depthOptions"
    />

    <FieldCheckbox
      v-model="attachImages"
      :label="t('settings.pages.modules.video.attach-images')"
      :description="t('settings.pages.modules.video.attach-images-description')"
    />

    <FieldCheckbox
      v-model="autonomous"
      :label="t('settings.pages.modules.video.autonomous')"
      :description="t('settings.pages.modules.video.autonomous-description')"
    />

    <FieldInput
      v-model="bilibiliCookie"
      type="password"
      :label="t('settings.pages.modules.video.bilibili-cookie')"
      :description="t('settings.pages.modules.video.bilibili-cookie-description')"
      :placeholder="t('settings.pages.modules.video.bilibili-cookie-placeholder')"
    />

    <Callout
      v-if="configured"
      theme="lime"
      :label="t('settings.pages.modules.video.configured')"
    />
    <Callout
      v-else-if="enabled && !runtimeAvailable"
      theme="orange"
      :label="t('settings.pages.modules.video.unavailable')"
    />
    <Callout
      theme="orange"
      :label="t('settings.pages.modules.video.ffmpeg-note')"
    />
  </SettingsCard>
</template>
