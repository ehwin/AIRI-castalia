<script setup lang="ts">
import type { LoopDiagnostics } from '@proj-airi/stage-ui/stores/modules/self-initiated-speech'

import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { ACTIVE_TUNING_GROUPS, ACTIVE_TUNING_PRESETS, ACTIVE_TUNING_SPECS } from '@proj-airi/castalia-plugin/tuning'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLLM } from '@proj-airi/stage-ui/stores/ai/chat-llm/llm'
import { useMemoryStore } from '@proj-airi/stage-ui/stores/memory'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { readSelfInitiatedDiagnostics, useSelfInitiatedSpeechStore } from '@proj-airi/stage-ui/stores/modules/self-initiated-speech'
import { FieldCheckbox, FieldRange, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { castaliaTuningGet, castaliaTuningSave } from '../../../../shared/eventa/castalia-memory'
import { systemPresenceGet } from '../../../../shared/eventa/presence'

// NOTICE: 覆盖 stage-pages 的同名页（见 electron.vite.config.ts 的 exclude）。
// 唯一原因：心智参数面板要调主进程的 eventa（tuning:get/save），而 stage-pages 拿不到 app 的
// shared/eventa；仓库里其它需要 eventa 的设置页（memory、home-assistant、mcp…）都是同样处理的。

const castalia = useCastaliaPluginStore()
const cards = useAiriCardStore()
const memory = useMemoryStore()
// 模型工具被服务商错误降级时，面板过去仍显示"已配置"（F13）。
const llm = useLLM()
const capabilities = computed(() => Object.entries(memory.backend?.capabilities ?? {}))
const { enabled, currentMood, currentDesire, currentEnergy, activeCharacterId, moodHistory } = storeToRefs(castalia)
const { locale, t } = useI18n()
// 主动开口的总开关。这一页本来就是「她什么时候自己说话」的落地页，
// 而它过去只有诊断没有开关：想让她安静只能去改代码或用调试接口。
const speech = useSelfInitiatedSpeechStore()
const { paused } = storeToRefs(speech)
const voiceEnabled = computed({
  get: () => !paused.value,
  set: next => speech.setSpeechPaused(!next),
})
// 「她为什么不主动开口」在别处没有答案：哨兵在内存里，重启就没。这里读落盘的那份。
// 设置窗口有自己的 store 实例、也不跑 ticker，直接读 `store.diagnostics` 永远是空值——
// 那会把「没有记录」印成「一切正常」。读 stage 窗口写下的那份才是真读数。
const selfInitiatedDiagnostics = ref<LoopDiagnostics | null>(null)
function refreshSelfInitiatedDiagnostics() {
  const personaId = memory.enabled ? memory.resolvePersona(cards.activeCardId) : cards.activeCardId
  selfInitiatedDiagnostics.value = readSelfInitiatedDiagnostics(personaId)
}
/**
 * 主进程直读的占用状态。
 *
 * 设置窗口不跑心智 tick，`useMindStore().presence` 在这里永远是空的；所以这项不走
 * store，而是直接问主进程。看到「active / idle 12s」就说明廉价那一路真的接上了。
 */
const invokeSystemPresence = useElectronEventaInvoke(systemPresenceGet)
const presence = ref<{ state: string, idleSeconds: number }>()
let presenceTimer: ReturnType<typeof setInterval> | undefined
async function refreshPresence() {
  try {
    presence.value = await invokeSystemPresence()
  }
  catch {
    presence.value = undefined
  }
}
onMounted(() => {
  void refreshPresence()
  refreshSelfInitiatedDiagnostics()
  presenceTimer = setInterval(() => {
    void refreshPresence()
    refreshSelfInitiatedDiagnostics()
  }, 5_000)
})
onUnmounted(() => {
  if (presenceTimer)
    clearInterval(presenceTimer)
})
const presenceLine = computed(() => {
  if (!presence.value)
    return t('settings.pages.modules.castalia.system-presence-unknown')
  return t('settings.pages.modules.castalia.system-presence', {
    state: presence.value.state,
    seconds: presence.value.idleSeconds,
  })
})
// 「那一眼花了多久」：超时预算够不够，看这个数，不靠猜。
const lookLine = computed(() => {
  const ms = selfInitiatedDiagnostics.value?.lookMs
  return ms ? t('settings.pages.modules.castalia.look-latency', { ms }) : ''
})
// 「她还在问你在忙吗」是这条链路唯一诚实的回归信号：问了，就说明上下文没压住模型。
const askedBusyLine = computed(() => {
  const at = selfInitiatedDiagnostics.value?.askedBusyAt
  if (!at)
    return t('settings.pages.modules.castalia.asked-busy-none')
  return t('settings.pages.modules.castalia.asked-busy', {
    at: new Date(at).toLocaleString(locale.value),
  })
})
const selfInitiatedLine = computed(() => {
  const state = selfInitiatedDiagnostics.value
  if (!state?.lastReasonAt)
    return t('settings.pages.modules.castalia.self-initiated-empty')
  const at = new Date(state.lastReasonAt).toLocaleString(locale.value)
  return t('settings.pages.modules.castalia.self-initiated-last', {
    reason: state.lastReason ?? '—',
    at,
    count: state.gatedCount ?? 0,
  })
})
// The newest five events are the short-term memory the next prompt carries.
// `psyche` is the mirror's own marker, not an event she lived through.
const recentMoodEvents = computed(() => moodHistory.value.filter(event => event.reason !== 'psyche').slice(-5).reverse())
// Zero is "steady". Having no reading is a different answer, and the panel used to print both as 0.
const moodKnown = computed(() =>
  Boolean(castalia.snapshotFor(activeCharacterId.value).vad) || moodHistory.value.length > 0)
// The chat maps `default` to `airi` before it touches Castalia, so the panel has to ask the same
// question: reading the raw card id showed an empty `default` partition next to a real `airi` one (F11).
watch(() => cards.activeCardId, (characterId) => {
  castalia.setCharacter(memory.enabled ? memory.resolvePersona(characterId) : characterId)
  refreshSelfInitiatedDiagnostics()
}, { immediate: true })

const KEY = 'settings.pages.modules.castalia'

// ── 心智 / 检索参数（2026-10-31）──────────────────────────────────────────
// 清单来自引擎侧（@proj-airi/castalia-plugin/tuning），这里只做表单 + 保存。
// psyche 那批参数每轮读取 → 存完即时生效；检索权重是模块级常量 → 要重启。
const invokeTuningGet = useElectronEventaInvoke(castaliaTuningGet)
const invokeTuningSave = useElectronEventaInvoke(castaliaTuningSave)

const tuningOpen = ref(true)
const tuningLoading = ref(false)
const tuningSaving = ref(false)
const tuningNote = ref('')
const tuningFile = ref('')
const tuningRestartNeeded = ref(false)
const draft = ref<Record<string, string>>({})

const labelOf = (o: { zh: string, en: string }) => (String(locale.value).startsWith('zh') ? o.zh : o.en)
// 画哪几组由引擎清单决定：心智版 8 组、记忆+面板版只有 search/inject、标准版带面板只有 search。
const specsOfGroup = (group: string) => ACTIVE_TUNING_SPECS.filter(spec => spec.group === group)
/** 该变体是否真的有可调项（memory-only 变体没有，整块不显示）。 */
const hasTuning = computed(() => ACTIVE_TUNING_SPECS.length > 0)
/**
 * 分组标题单独列成字面量：仓库的 settings-search 插件在构建期静态扫 `t('...')`，
 * 拼出来的 key（`t(\`${KEY}.tuning_group_${group}\`)`）会让构建直接失败。
 */
const groupLabels = computed<Record<string, string>>(() => ({
  band: t('settings.pages.modules.castalia.tuning_group_band'),
  halfLife: t('settings.pages.modules.castalia.tuning_group_halfLife'),
  mood: t('settings.pages.modules.castalia.tuning_group_mood'),
  gain: t('settings.pages.modules.castalia.tuning_group_gain'),
  trait: t('settings.pages.modules.castalia.tuning_group_trait'),
  evidence: t('settings.pages.modules.castalia.tuning_group_evidence'),
  search: t('settings.pages.modules.castalia.tuning_group_search'),
  inject: t('settings.pages.modules.castalia.tuning_group_inject'),
}))
const tuningIsCustom = computed(() => Object.keys(draft.value).length > 0)

function fillDraft(values: Record<string, string>) {
  const next: Record<string, string> = {}
  for (const spec of ACTIVE_TUNING_SPECS) {
    if (values[spec.key] !== undefined)
      next[spec.key] = values[spec.key]
  }
  draft.value = next
}

async function loadTuning() {
  tuningLoading.value = true
  try {
    const snapshot = await invokeTuningGet()
    tuningFile.value = snapshot.file
    tuningRestartNeeded.value = snapshot.needsRestart
    fillDraft(snapshot.values)
    if (snapshot.rejected.length)
      tuningNote.value = `${t(`${KEY}.tuning_rejected`)}: ${snapshot.rejected.map(item => `${item.key}(${item.reason})`).join(', ')}`
  }
  catch (error) {
    tuningNote.value = (error as Error).message
  }
  finally {
    tuningLoading.value = false
  }
}

async function persistTuning(values: Record<string, string | null>) {
  tuningSaving.value = true
  tuningNote.value = ''
  try {
    const snapshot = await invokeTuningSave({ values })
    tuningFile.value = snapshot.file
    tuningRestartNeeded.value = snapshot.needsRestart
    fillDraft(snapshot.values)
    if (snapshot.rejected.length) {
      tuningNote.value = `${t(`${KEY}.tuning_rejected`)}: ${snapshot.rejected.map(item => `${item.key}(${item.reason})`).join(', ')}`
    }
    else {
      tuningNote.value = snapshot.needsRestart
        ? t(`${KEY}.tuning_saved_restart`)
        : t(`${KEY}.tuning_saved`)
    }
  }
  catch (error) {
    tuningNote.value = (error as Error).message
  }
  finally {
    tuningSaving.value = false
  }
}

/** 表单里的空值 = 回默认（null），非空则原样提交，越界由主进程拒绝。 */
async function saveTuning() {
  const values: Record<string, string | null> = {}
  for (const spec of ACTIVE_TUNING_SPECS) {
    const raw = draft.value[spec.key]
    values[spec.key] = raw === undefined || raw === '' ? null : raw
  }
  await persistTuning(values)
}

/** 套预设：预设没提到的键一律回默认，保证「切过去就是你看到的那组」。 */
async function applyPreset(id: string) {
  const preset = ACTIVE_TUNING_PRESETS[id]
  if (!preset)
    return
  const values: Record<string, string | null> = {}
  for (const spec of ACTIVE_TUNING_SPECS)
    values[spec.key] = preset.values[spec.key] ?? null
  await persistTuning(values)
}

async function resetTuning() {
  const values: Record<string, string | null> = {}
  for (const spec of ACTIVE_TUNING_SPECS) values[spec.key] = null
  await persistTuning(values)
}

onMounted(() => {
  if (hasTuning.value)
    void loadTuning()
})
</script>

<template>
  <SettingsCard>
    <div class="flex flex-col gap-4">
      <FieldCheckbox
        v-model="enabled"
        :label="t('settings.pages.modules.castalia.enable')"
        :description="t('settings.pages.modules.castalia.enable-description')"
      />
      <FieldCheckbox
        v-model="voiceEnabled"
        :label="t('settings.pages.modules.castalia.voice-enable')"
        :description="t('settings.pages.modules.castalia.voice-enable-description')"
      />
      <FieldRange
        :model-value="castalia.snapshotFor(activeCharacterId).tsundereLevel"
        :label="t('settings.pages.modules.castalia.tsundere-level')"
        :description="t('settings.pages.modules.castalia.tsundere-level-description')"
        :min="0"
        :max="10"
        :step="1"
        @update:model-value="castalia.setTsundereLevel($event, activeCharacterId)"
      />
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="text-sm text-neutral-500">
            {{ t('settings.pages.modules.castalia.mood') }}
          </div>
          <div class="text-xl font-medium">
            <template v-if="moodKnown">
              {{ currentMood }}
            </template>
            <span v-else class="text-base text-neutral-400 font-normal">
              {{ t('settings.pages.modules.castalia.no-mood-evidence') }}
            </span>
          </div>
        </div>
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="text-sm text-neutral-500">
            {{ t('settings.pages.modules.castalia.desire') }}
          </div>
          <div class="text-base font-medium">
            {{ currentDesire || t('settings.pages.modules.castalia.no-desire') }}
          </div>
        </div>
        <div class="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800">
          <div class="text-sm text-neutral-500">
            {{ t('settings.pages.modules.castalia.energy') }}
          </div>
          <div class="text-xl font-medium">
            {{ currentEnergy }}%
          </div>
        </div>
      </div>
      <p class="text-sm text-neutral-500">
        {{ t('settings.pages.modules.castalia.status-description') }}
      </p>
      <!-- 后端实况（F05/F13）：开关只说"开没开"，这里说"能不能用"。 -->
      <div class="rounded-lg bg-neutral-50 p-3 text-sm dark:bg-neutral-800">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span class="font-medium">{{ t('settings.pages.modules.castalia.backend-title') }}</span>
          <span class="text-xs text-neutral-500">
            {{ memory.backend?.transport ?? '—' }} · {{ memory.backend?.project ?? '?' }}/{{ memory.backend?.character ?? '?' }}
          </span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="[name, ok] in capabilities"
            :key="name"
            class="rounded px-1.5 py-0.5 text-xs"
            :class="ok
              ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
              : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'"
          >{{ ok ? '✓' : '✗' }} {{ name }}</span>
        </div>
        <!-- 「记忆存在哪」的答案：用户要能顺着这个目录自己找到库文件，而不是去猜。 -->
        <div v-if="memory.backend?.bankDir" class="mt-2 break-all text-xs text-neutral-500">
          {{ t('settings.pages.modules.castalia.backend-bank-dir') }}
          <code class="select-all font-mono">{{ memory.backend.bankDir }}</code>
        </div>
        <p v-if="memory.backend?.emotion" class="mt-2 text-xs text-neutral-500">
          {{ memory.backend.emotion.note }}
        </p>
        <p v-if="memory.backend?.entries?.truncated" class="mt-1 text-xs text-amber-600">
          {{ t('settings.pages.modules.castalia.backend-truncated', { listed: memory.backend.entries.listed }) }}
        </p>
        <p v-if="memory.backend?.error" class="mt-1 text-xs text-red-600">
          {{ memory.backend.error }}
        </p>
        <p class="mt-1 text-xs text-neutral-500">
          {{ t('settings.pages.modules.castalia.self-initiated') }} · {{ selfInitiatedLine }}
        </p>
        <p class="mt-1 text-xs text-neutral-500">
          {{ presenceLine }}
        </p>
        <p v-if="lookLine" class="mt-1 text-xs text-neutral-500">
          {{ lookLine }}
        </p>
        <p class="mt-1 text-xs text-neutral-500">
          {{ askedBusyLine }}
        </p>
        <div v-if="llm.toolsDisabledFor.length" class="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-600">
          <span>{{ t('settings.pages.modules.castalia.backend-tools-disabled', { models: llm.toolsDisabledFor.join(', ') }) }}</span>
          <button
            class="rounded bg-neutral-200 px-2 py-0.5 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
            @click="llm.retryToolSupport()"
          >
            {{ t('settings.pages.modules.castalia.backend-retry-tools') }}
          </button>
        </div>
      </div>
      <div class="flex flex-col gap-2">
        <div class="text-sm font-medium">
          {{ t('settings.pages.modules.castalia.short-term-memory') }}
        </div>
        <p class="text-xs text-neutral-500">
          {{ t('settings.pages.modules.castalia.short-term-memory-description') }}
        </p>
        <ul v-if="recentMoodEvents.length" class="flex flex-col gap-1">
          <li
            v-for="event in recentMoodEvents"
            :key="`${event.timestamp}-${event.reason}`"
            class="flex items-baseline justify-between gap-3 rounded-md bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800"
          >
            <span class="truncate">{{ event.reason }}</span>
            <span class="shrink-0 text-neutral-500">{{ event.value > 0 ? '+' : '' }}{{ event.value }}</span>
          </li>
        </ul>
        <p v-else class="text-sm text-neutral-500">
          {{ t('settings.pages.modules.castalia.no-short-term-memory') }}
        </p>
      </div>
    </div>
  </SettingsCard>

  <!-- 心智参数：清单在引擎侧，这里只是表单 -->
  <SettingsCard v-if="hasTuning">
    <div :class="['flex flex-col', 'gap-3']">
      <header :class="['flex flex-wrap items-baseline', 'gap-2']">
        <h2 :class="['text-sm font-medium']">
          {{ t(`${KEY}.tuning_title`) }}
        </h2>
        <span v-if="tuningIsCustom" :class="['text-xs', 'text-primary-500']">{{ t(`${KEY}.tuning_custom`) }}</span>
        <button
          type="button"
          :class="['ml-auto', 'rounded-lg', 'px-3 py-1.5', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700']"
          @click="tuningOpen = !tuningOpen"
        >
          {{ tuningOpen ? t(`${KEY}.tuning_hide`) : t(`${KEY}.tuning_show`) }}
        </button>
      </header>
      <p :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.tuning_description`) }}
      </p>

      <div v-if="tuningOpen" :class="['flex flex-col', 'gap-4']">
        <div :class="['flex flex-wrap', 'gap-2']">
          <button
            v-for="(preset, id) in ACTIVE_TUNING_PRESETS"
            :key="id"
            type="button"
            :disabled="tuningSaving"
            :title="preset.note ? labelOf(preset.note) : ''"
            :class="['rounded-full', 'px-3 py-1', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700', tuningSaving ? 'opacity-50' : '']"
            @click="applyPreset(String(id))"
          >
            {{ labelOf(preset.label) }}
          </button>
          <button
            type="button"
            :disabled="tuningSaving"
            :class="['rounded-full', 'px-3 py-1', 'text-xs', 'border', 'border-neutral-300 dark:border-neutral-600', 'hover:bg-neutral-100 dark:hover:bg-neutral-700']"
            @click="resetTuning"
          >
            {{ t(`${KEY}.tuning_reset`) }}
          </button>
        </div>

        <div v-for="group in ACTIVE_TUNING_GROUPS" :key="group" :class="['flex flex-col', 'gap-2']">
          <h3 :class="['text-[11px]', 'uppercase', 'tracking-wide', 'text-neutral-400 dark:text-neutral-500']">
            {{ groupLabels[group] }}
          </h3>
          <label
            v-for="spec in specsOfGroup(group)"
            :key="spec.key"
            :title="spec.hint ? labelOf(spec.hint) : spec.key"
            :class="['flex items-center', 'gap-3', 'text-sm']"
          >
            <span :class="['min-w-0 flex-1', 'flex flex-wrap items-baseline', 'gap-1.5']">
              <span>{{ labelOf(spec.label) }}</span>
              <code :class="['text-[10px]', 'text-neutral-400 dark:text-neutral-500']">{{ spec.default }}</code>
              <span v-if="spec.restart" :class="['rounded', 'bg-amber-100 dark:bg-amber-500/20', 'px-1', 'text-[10px]', 'text-amber-700 dark:text-amber-300']">
                {{ t(`${KEY}.tuning_restart_badge`) }}
              </span>
            </span>
            <input
              v-model="draft[spec.key]"
              type="number"
              :min="spec.min"
              :max="spec.max"
              :step="spec.step"
              :placeholder="String(spec.default)"
              :class="['w-24 shrink-0', 'rounded-lg', 'border', 'border-neutral-200 dark:border-neutral-700', 'bg-white dark:bg-neutral-900', 'px-2 py-1', 'text-sm', 'outline-none', 'focus:border-primary-400']"
            >
          </label>
        </div>

        <div :class="['flex flex-wrap items-center', 'gap-2']">
          <button
            type="button"
            :disabled="tuningSaving || tuningLoading"
            :class="['rounded-lg', 'px-4 py-2', 'text-sm', 'bg-primary-500 text-white', 'hover:bg-primary-600', 'disabled:opacity-50']"
            @click="saveTuning"
          >
            {{ tuningSaving ? t(`${KEY}.tuning_saving`) : t(`${KEY}.tuning_apply`) }}
          </button>
          <span v-if="tuningNote" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">{{ tuningNote }}</span>
        </div>

        <p v-if="tuningRestartNeeded" :class="['text-xs', 'text-amber-600 dark:text-amber-400']">
          {{ t(`${KEY}.tuning_restart_note`) }}
        </p>
        <p v-if="tuningFile" :class="['text-[11px]', 'text-neutral-400 dark:text-neutral-500', 'break-all']">
          {{ tuningFile }}
        </p>
      </div>
    </div>
  </SettingsCard>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.castalia.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
