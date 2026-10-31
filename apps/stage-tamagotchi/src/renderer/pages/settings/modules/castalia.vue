<script setup lang="ts">
import { ACTIVE_TUNING_GROUPS, ACTIVE_TUNING_PRESETS, ACTIVE_TUNING_SPECS } from '@proj-airi/castalia-plugin/tuning'
import { useCastaliaPluginStore } from '@proj-airi/castalia-plugin'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { FieldCheckbox, FieldRange, SettingsCard } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { castaliaTuningGet, castaliaTuningSave } from '../../../../shared/eventa/castalia-memory'

// NOTICE: 覆盖 stage-pages 的同名页（见 electron.vite.config.ts 的 exclude）。
// 唯一原因：心智参数面板要调主进程的 eventa（tuning:get/save），而 stage-pages 拿不到 app 的
// shared/eventa；仓库里其它需要 eventa 的设置页（memory、home-assistant、mcp…）都是同样处理的。

const castalia = useCastaliaPluginStore()
const cards = useAiriCardStore()
const { enabled, currentMood, currentDesire, currentEnergy, activeCharacterId, moodHistory } = storeToRefs(castalia)
const { locale, t } = useI18n()
// The newest five events are the short-term memory the next prompt carries.
const recentMoodEvents = computed(() => moodHistory.value.slice(-5).reverse())
watch(() => cards.activeCardId, characterId => castalia.setCharacter(characterId), { immediate: true })

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
            {{ currentMood }}
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
