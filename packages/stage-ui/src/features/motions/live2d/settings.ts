import type { Live2DMotionMagicProfileId } from './profiles'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { watch } from 'vue'

import { defaultLive2DMotionMagicProfileId, live2dMotionMagicProfiles } from './profiles'

const profileId = useLocalStorageManualReset('settings/live2d/magic/profile', defaultLive2DMotionMagicProfileId)
const method = useLocalStorageManualReset<'var' | 'ar-hmm'>('settings/live2d/magic/method', 'var')
const arHmmStateCount = useLocalStorageManualReset('settings/live2d/magic/ar-hmm/state-count', 5)
const arHmmOrder = useLocalStorageManualReset('settings/live2d/magic/ar-hmm/order', 12)
const arHmmNoiseScale = useLocalStorageManualReset('settings/live2d/magic/ar-hmm/noise-scale', 0.8)
const skipMouthOpen = useLocalStorageManualReset('settings/live2d/magic/skip-mouth-open', true)
const forceViewTarget = useLocalStorageManualReset('settings/live2d/magic/force-view-target', true)

function isKnownProfileId(value: unknown): value is Live2DMotionMagicProfileId {
  return typeof value === 'string' && Object.hasOwn(live2dMotionMagicProfiles, value)
}

watch(profileId, (value) => {
  // Persisted settings can outlive bundled profiles. Restore the default before runtime consumers
  // use the ID to access the profile registry.
  if (!isKnownProfileId(value))
    profileId.value = defaultLive2DMotionMagicProfileId
}, { flush: 'sync', immediate: true })

watch(method, (value) => {
  if (value !== 'var' && value !== 'ar-hmm')
    method.value = 'var'
}, { flush: 'sync', immediate: true })

watch(arHmmStateCount, (value) => {
  arHmmStateCount.value = Math.round(Math.max(2, Math.min(12, Number(value) || 5)))
}, { flush: 'sync', immediate: true })

watch(arHmmOrder, (value) => {
  arHmmOrder.value = Math.round(Math.max(1, Math.min(24, Number(value) || 12)))
}, { flush: 'sync', immediate: true })

watch(arHmmNoiseScale, (value) => {
  arHmmNoiseScale.value = Math.max(0, Math.min(2, Number.isFinite(value) ? value : 0.8))
}, { flush: 'sync', immediate: true })

/** Persists production settings for the MAGIC Live2D motion driver. */
export const useLive2DMotionMagicSettings = defineStore('settings-live2d-motion-magic', () => {
  function resetState() {
    profileId.reset()
    method.reset()
    arHmmStateCount.reset()
    arHmmOrder.reset()
    arHmmNoiseScale.reset()
    skipMouthOpen.reset()
    forceViewTarget.reset()
  }

  return {
    profileId,
    method,
    arHmmStateCount,
    arHmmOrder,
    arHmmNoiseScale,
    skipMouthOpen,
    forceViewTarget,
    resetState,
  }
})
