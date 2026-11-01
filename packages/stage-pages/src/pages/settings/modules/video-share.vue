<script setup lang="ts">
import { VideoShareCards } from '@proj-airi/stage-ui/components'
</script>

<template>
  <!-- `apply`: this page runs in the window that owns the castalia engine and the memory store, so
       an answer can land on her state straight away instead of waiting for the next tick. -->
  <VideoShareCards apply :limit="30" />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.video-share.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
