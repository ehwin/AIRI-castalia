<script setup lang="ts">
import type { OnboardingStepNextHandler, OnboardingStepPrevHandler } from './types'

import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { Button, Checkbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMemoryStore } from '../../../../stores/memory'
import { useSelfInitiatedSpeechStore } from '../../../../stores/modules/self-initiated-speech'

const props = defineProps<{
  onNext: OnboardingStepNextHandler
  onPrevious?: OnboardingStepPrevHandler
}>()
const { t } = useI18n()

const memory = useMemoryStore()
const { enabled: memoryEnabled, backend } = storeToRefs(memory)

const speech = useSelfInitiatedSpeechStore()
const { paused } = storeToRefs(speech)

// 面板上的开关是「她在你安静时会自己开口」，存的却是它的反面：静音键。
const voiceEnabled = computed({
  get: () => !paused.value,
  set: next => speech.setSpeechPaused(!next),
})

/**
 * 记忆库的真实目录。
 *
 * 主进程没报目录时宁可说「还没建」，也不要编一个路径：这句话她以后要照着去找文件。
 */
const bankDir = computed(() => backend.value?.bankDir ?? '')

// 桌面端把记忆放在一个有路径的目录里，网页端放在站点存储里。同一句话不能两处都说，
// 否则用户会拿着一个不存在的目录去找她记得的东西。
const desktop = isStageTamagotchi()
const memoryBody = computed(() => desktop
  ? t('settings.dialogs.onboarding.castalia.memory-body')
  : t('settings.dialogs.onboarding.castalia.memory-body-web'))
const memoryFallback = computed(() => desktop
  ? t('settings.dialogs.onboarding.castalia.memory-unknown')
  : t('settings.dialogs.onboarding.castalia.memory-browser'))

const bankMeta = computed(() => {
  const current = backend.value
  if (!current?.project && !current?.character)
    return ''
  return `${current?.project ?? '?'} / ${current?.character ?? '?'}`
})
</script>

<template>
  <div :class="['min-h-0 flex min-w-0 flex-1 flex-col gap-4']">
    <div sticky top-0 z-100 flex flex-shrink-0 items-center gap-2>
      <button outline-none @click="props.onPrevious?.()">
        <div i-solar:alt-arrow-left-line-duotone h-5 w-5 />
      </button>
      <h2 class="flex-1 text-center text-xl text-neutral-800 font-semibold md:text-left md:text-2xl dark:text-neutral-100">
        {{ t('settings.dialogs.onboarding.castalia.title') }}
      </h2>
      <div h-5 w-5 />
    </div>

    <div :class="['min-h-0 flex flex-1 flex-col gap-3 overflow-y-auto pr-1']">
      <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.dialogs.onboarding.castalia.description') }}
      </p>

      <section :class="['flex flex-col gap-1 rounded-xl bg-neutral-100/70 p-3 dark:bg-neutral-800/50']">
        <div :class="['flex items-center gap-2 text-sm text-neutral-700 font-medium dark:text-neutral-200']">
          <div i-solar:database-bold-duotone h-4 w-4 />
          {{ t('settings.dialogs.onboarding.castalia.memory-title') }}
        </div>
        <p :class="['text-xs text-neutral-500 dark:text-neutral-400']">
          {{ memoryBody }}
        </p>
        <code
          v-if="bankDir"
          :class="['select-all break-all rounded-lg bg-white/70 px-2 py-1 font-mono text-xs text-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-200']"
        >{{ bankDir }}</code>
        <p v-else :class="['text-xs text-neutral-400 dark:text-neutral-500']">
          {{ memoryFallback }}
        </p>
        <p v-if="bankMeta" :class="['font-mono text-xs text-neutral-400 dark:text-neutral-500']">
          {{ t('settings.dialogs.onboarding.castalia.memory-meta', { bank: bankMeta }) }}
        </p>
      </section>

      <section :class="['flex flex-col gap-1 rounded-xl bg-neutral-100/70 p-3 dark:bg-neutral-800/50']">
        <div :class="['flex items-center gap-2 text-sm text-neutral-700 font-medium dark:text-neutral-200']">
          <div i-solar:chat-round-dots-bold-duotone h-4 w-4 />
          {{ t('settings.dialogs.onboarding.castalia.voice-title') }}
        </div>
        <ul :class="['ml-4 list-disc text-xs text-neutral-500 dark:text-neutral-400']">
          <li>{{ t('settings.dialogs.onboarding.castalia.when-awake') }}</li>
          <li>{{ t('settings.dialogs.onboarding.castalia.when-gap') }}</li>
          <li>{{ t('settings.dialogs.onboarding.castalia.when-quiet-office') }}</li>
          <li>{{ t('settings.dialogs.onboarding.castalia.when-unanswered') }}</li>
        </ul>
      </section>

      <section :class="['flex flex-col gap-3 rounded-xl bg-neutral-100/70 p-3 dark:bg-neutral-800/50']">
        <div :class="['flex items-center gap-2 text-sm text-neutral-700 font-medium dark:text-neutral-200']">
          <div i-solar:power-bold-duotone h-4 w-4 />
          {{ t('settings.dialogs.onboarding.castalia.off-title') }}
        </div>

        <label :class="['flex items-center justify-between gap-3 text-xs text-neutral-600 dark:text-neutral-300']">
          <span>{{ t('settings.dialogs.onboarding.castalia.off-memory') }}</span>
          <Checkbox v-model="memoryEnabled" data-testid="onboarding-memory-switch" />
        </label>
        <label :class="['flex items-center justify-between gap-3 text-xs text-neutral-600 dark:text-neutral-300']">
          <span>{{ t('settings.dialogs.onboarding.castalia.off-voice') }}</span>
          <Checkbox v-model="voiceEnabled" data-testid="onboarding-voice-switch" />
        </label>

        <p :class="['text-xs text-neutral-400 dark:text-neutral-500']">
          {{ t('settings.dialogs.onboarding.castalia.off-later') }}
        </p>
      </section>
    </div>

    <div class="w-full flex-shrink-0">
      <Button
        class="w-full"
        data-testid="onboarding-castalia-start"
        :label="t('settings.dialogs.onboarding.castalia.start')"
        @click="props.onNext"
      />
    </div>
  </div>
</template>
