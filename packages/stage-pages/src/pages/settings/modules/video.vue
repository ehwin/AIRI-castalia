<script setup lang="ts">
import { Video } from '@proj-airi/stage-ui/components'
</script>

<template>
  <Video />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.video.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
