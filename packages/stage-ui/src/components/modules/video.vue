<script setup lang="ts">
import { Callout, FieldCheckbox, FieldInput, FieldSelect, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useVideoStore } from '../../stores/modules/video'

const { t } = useI18n()
const videoStore = useVideoStore()
const { enabled, depth, attachImages, bilibiliCookie, autonomous, ffmpegPath, ffmpegAvailable, ffmpegDetected, cacheDir, configured, runtimeAvailable } = storeToRefs(videoStore)

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

    <FieldInput
      v-model="ffmpegPath"
      :label="t('settings.pages.modules.video.ffmpeg-path')"
      :description="t('settings.pages.modules.video.ffmpeg-path-description')"
      :placeholder="ffmpegDetected || 'C:/tools/ffmpeg/bin/ffmpeg.exe'"
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

    <!-- Only when the shell really cannot find a decoder: an always-on warning trains the eye to
         ignore it, and the machine fact is one invoke away. -->
    <Callout
      v-if="runtimeAvailable && !ffmpegAvailable"
      theme="orange"
      :label="t('settings.pages.modules.video.ffmpeg-missing')"
    />
    <p
      v-else-if="runtimeAvailable && ffmpegAvailable"
      class="text-xs text-neutral-500"
    >
      {{ t('settings.pages.modules.video.ffmpeg-found', { path: ffmpegPath || ffmpegDetected }) }}
      <span v-if="cacheDir">· {{ t('settings.pages.modules.video.cache-dir', { path: cacheDir }) }}</span>
    </p>
  </SettingsCard>
</template>
