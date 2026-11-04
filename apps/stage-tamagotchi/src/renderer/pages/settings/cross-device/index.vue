<script setup lang="ts">
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useRemoteStageStore } from '@proj-airi/stage-ui/stores/remote-stage'
import { FieldCheckbox, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const remoteStage = useRemoteStageStore()
const channel = useModsServerChannelStore()
const { peers, remoteOnline, preferRemoteVoice, lastTurnAt } = storeToRefs(remoteStage)

// This window runs its own channel client, so it reads the same registry the stage does.
remoteStage.start()

// Three honest states: the channel itself may be down, which is neither "online" nor "offline".
const status = computed<'online' | 'offline' | 'unknown'>(() => {
  if (!channel.connected)
    return 'unknown'
  return remoteOnline.value ? 'online' : 'offline'
})

// The "last request" line would otherwise freeze at the value it had when the page opened.
const now = ref(Date.now())
const ticker = setInterval(() => {
  now.value = Date.now()
}, 15_000)
onUnmounted(() => clearInterval(ticker))
const lastTurnMinutes = computed(() => lastTurnAt.value
  ? Math.max(1, Math.round((now.value - lastTurnAt.value) / 60_000))
  : null)
</script>

<template>
  <div flex="~ col gap-6 pb-4">
    <SettingsCard>
      <div flex="~ col gap-4">
        <div>
          <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-400">
            {{ t('settings.pages.cross-device.devices') }}
          </h2>
          <div text="neutral-400 dark:neutral-500">
            <span>{{ t('settings.pages.cross-device.description') }}</span>
          </div>
        </div>

        <div flex="~ col gap-2" text-sm>
          <div flex="~ items-center gap-2">
            <span
              class="h-2 w-2 rounded-full"
              :class="status === 'online' ? 'bg-emerald-500' : status === 'unknown' ? 'bg-amber-500' : 'bg-neutral-400'"
            />
            <span>
              {{ status === 'online'
                ? t('settings.pages.cross-device.online')
                : status === 'unknown'
                  ? t('settings.pages.cross-device.unknown')
                  : t('settings.pages.cross-device.offline') }}
            </span>
          </div>
          <div v-if="status === 'offline'" text="neutral-400 dark:neutral-500">
            {{ t('settings.pages.cross-device.empty') }}
          </div>
          <ul v-if="peers.length > 0" flex="~ col gap-1">
            <li v-for="peer in peers" :key="peer.id" flex="~ items-center gap-2">
              <span i-solar:smartphone-2-bold-duotone class="text-base text-neutral-500 dark:text-neutral-400" />
              <span text-xs font-mono>{{ peer.name }} · {{ peer.id }}</span>
            </li>
          </ul>
          <div v-if="lastTurnMinutes !== null" text="xs neutral-400 dark:neutral-500">
            {{ t('settings.pages.cross-device.last-turn', { minutes: lastTurnMinutes }) }}
          </div>
        </div>
      </div>
    </SettingsCard>

    <SettingsCard>
      <div flex="~ col gap-4">
        <h2 class="text-lg text-neutral-500 md:text-2xl dark:text-neutral-400">
          {{ t('settings.pages.cross-device.voice.title') }}
        </h2>
        <FieldCheckbox
          v-model="preferRemoteVoice"
          :label="t('settings.pages.cross-device.voice.switch')"
        />
        <div text="xs neutral-400 dark:neutral-500">
          {{ t('settings.pages.cross-device.voice.hint') }}
        </div>
        <div v-if="channel.connected" text="xs neutral-400 dark:neutral-500">
          {{ channel.websocketUrl }}
        </div>
      </div>
    </SettingsCard>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.cross-device.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.cross-device.description
  icon: i-solar:devices-bold-duotone
  settingsEntry: true
  order: 6
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
