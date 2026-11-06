<script setup lang="ts">
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { SettingsCard } from '@proj-airi/ui'
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { castaliaConsoleEmbed } from '../../../../shared/eventa/castalia-memory'

// 记忆体的三块界面（星图 / 记忆总成 / 库管理）就是原有的控制台，没有重写：
// 主进程用 `ELECTRON_RUN_AS_NODE` 把它拉成子进程，这里只负责把它嵌进设置页。
// 之所以嵌而不是重做：星图的 UMAP 布局、跨库聚合、库管理加起来是几千行，
// 重写一遍只会多一份要同步的实现。
const { t } = useI18n()
const invokeConsole = useElectronEventaInvoke(castaliaConsoleEmbed)

const url = ref('')
const error = ref('')
const loading = ref(true)

onMounted(async () => {
  try {
    const state = await invokeConsole()
    if (state.running && state.url)
      url.value = `${state.url}/?embed=1`
    else
      error.value = state.error ?? t('settings.pages.modules.memory-console.failed')
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    loading.value = false
  }
})
</script>

<template>
  <div :class="['flex flex-col', 'gap-3']">
    <SettingsCard v-if="loading">
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-console.loading') }}
      </p>
    </SettingsCard>

    <SettingsCard v-else-if="error">
      <p :class="['text-sm', 'text-red-500 dark:text-red-400']">
        {{ error }}
      </p>
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-console.failed-hint') }}
      </p>
    </SettingsCard>

    <div
      v-show="url"
      :class="['w-full', 'overflow-hidden', 'rounded-xl', 'border', 'border-neutral-200', 'dark:border-neutral-800']"
    >
      <iframe
        :src="url"
        :class="['h-[76vh]', 'w-full', 'border-0']"
        referrerpolicy="no-referrer"
      />
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-console.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
