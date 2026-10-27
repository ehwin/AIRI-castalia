import type { FeatureFlag } from '../libs/feature-flags'

import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { parse } from 'valibot'
import { computed } from 'vue'

import { featureFlagPreferencesSchema, featureFlagVariantPreferencesSchema, offeredFeatureFlags, resolveFeatureFlag, resolveFeatureVariant } from '../libs/feature-flags'

/** Owns the device preferences of the experiments. */
export const useFeatureFlagsStore = defineStore('feature-flags', () => {
  const offered = offeredFeatureFlags(isStageTamagotchi())
  const preferences = useLocalStorageManualReset<Record<string, boolean>>('settings/feature-flags', {}, {
    serializer: {
      read: value => parse(featureFlagPreferencesSchema, JSON.parse(value)),
      write: value => JSON.stringify(value),
    },
  })
  /** The variant that the user chose for each feature that has variants. It is a device choice. */
  const variantPreferences = useLocalStorageManualReset<Record<string, string>>('settings/feature-flag-variants', {}, {
    serializer: {
      read: value => parse(featureFlagVariantPreferencesSchema, JSON.parse(value)),
      write: value => JSON.stringify(value),
    },
  })

  function decision(feature: FeatureFlag) {
    return resolveFeatureFlag(feature, preferences.value[feature.key])
  }

  /** The variant of a feature: the saved one while the feature still offers it, otherwise the first one. */
  function variantOf(key: string): string | undefined {
    return resolveFeatureVariant(offered.find(feature => feature.key === key), variantPreferences.value[key])
  }

  /** Saves the variant of a feature. A value that the feature does not offer changes nothing. */
  function setVariant(key: string, value: string | undefined) {
    const options = offered.find(feature => feature.key === key)?.variants?.options
    if (!value || !options?.some(option => option.value === value) || variantPreferences.value[key] === value)
      return
    variantPreferences.value = { ...variantPreferences.value, [key]: value }
  }

  const features = computed(() => offered.map(feature => ({
    ...feature,
    ...decision(feature),
    preference: preferences.value[feature.key],
    variant: variantOf(feature.key),
  })).filter(feature => feature.selectable))

  function setPreference(key: string, value: boolean | undefined) {
    const feature = offered.find(feature => feature.key === key)
    if (!feature)
      return
    if (preferences.value[key] === value)
      return

    const next = { ...preferences.value }
    if (value === undefined)
      delete next[key]
    else
      next[key] = value
    preferences.value = next
  }

  /** Unknown features, and features that this app does not offer, stay disabled. */
  function isEnabled(key: string): boolean {
    const feature = offered.find(feature => feature.key === key)
    if (!feature)
      return false

    return decision(feature).enabled
  }

  return { features, setPreference, isEnabled, variantOf, setVariant }
})
