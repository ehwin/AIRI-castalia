<script setup lang="ts">
import type { CastaliaSettingsSnapshot } from '../../../../shared/eventa/castalia-memory'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { FieldInput, FieldSelect, SettingsCard } from '@proj-airi/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { castaliaSettingsGet, castaliaSettingsSave } from '../../../../shared/eventa/castalia-memory'

// 这份配置原来只能手改 <bankDir>/config.json：字段名还分模式（api 用 api_model / api_url，
// ollama 用 model / ollama_url），写错不报错，只会静默退回默认模型。这里把它做成表单。
const { t } = useI18n()
/** 这两页只在公开版出现（构建时 `VITE_AIRI_EDITION=public`）；私有版用 3348 控制台。 */
const PUBLIC_EDITION = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AIRI_EDITION === 'public'
const invokeGet = useElectronEventaInvoke(castaliaSettingsGet)
const invokeSave = useElectronEventaInvoke(castaliaSettingsSave)

const snapshot = ref<CastaliaSettingsSnapshot>()
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const note = ref('')

const form = ref({
  mode: 'ollama' as 'api' | 'ollama' | 'none',
  apiUrl: '',
  apiModel: '',
  ollamaUrl: '',
  model: '',
  dim: '',
  embeddingKey: '',
  reflectUrl: '',
  reflectModel: '',
  reflectMaxTokens: '',
  reflectFactExtraction: '',
  reflectMaxFacts: '',
  reflectKey: '',
  triageUrl: '',
  triageModel: '',
  triageKey: '',
})

const modeOptions = computed(() => [
  { label: t('settings.pages.modules.memory-api.embedding.mode-api'), value: 'api' },
  { label: t('settings.pages.modules.memory-api.embedding.mode-ollama'), value: 'ollama' },
  { label: t('settings.pages.modules.memory-api.embedding.mode-none'), value: 'none' },
])

function toNumber(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed)
    return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 空输入不写进 config.json。
 *
 * 表单把所有字段都带上时，留空的项会以 `""` 落盘 —— 表现在库里多出 `"api_url": ""` 这种
 * 没人写过的键，而且计数里也算一项。空字符串和不存在的键，引擎那边是同一个意思。
 */
function text(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const next = await invokeGet()
    snapshot.value = next
    form.value = {
      mode: next.embedding.mode,
      apiUrl: next.embedding.apiUrl,
      apiModel: next.embedding.apiModel,
      ollamaUrl: next.embedding.ollamaUrl,
      model: next.embedding.model,
      dim: next.embedding.dim === undefined ? '' : String(next.embedding.dim),
      embeddingKey: '',
      reflectUrl: next.reflect.llmUrl,
      reflectModel: next.reflect.model,
      reflectMaxTokens: next.reflect.maxTokens === undefined ? '' : String(next.reflect.maxTokens),
      reflectFactExtraction: next.reflect.factExtraction,
      reflectMaxFacts: next.reflect.maxFacts === undefined ? '' : String(next.reflect.maxFacts),
      reflectKey: '',
      triageUrl: next.triage.llmUrl,
      triageModel: next.triage.model,
      triageKey: '',
    }
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  note.value = ''
  try {
    const result = await invokeSave({
      patch: {
        embedding: {
          mode: form.value.mode,
          apiUrl: text(form.value.apiUrl),
          apiModel: text(form.value.apiModel),
          ollamaUrl: text(form.value.ollamaUrl),
          model: text(form.value.model),
          dim: toNumber(form.value.dim),
          ...(form.value.embeddingKey.trim() ? { apiKey: form.value.embeddingKey.trim() } : {}),
        },
        reflect: {
          llmUrl: text(form.value.reflectUrl),
          model: text(form.value.reflectModel),
          maxTokens: toNumber(form.value.reflectMaxTokens),
          factExtraction: text(form.value.reflectFactExtraction),
          maxFacts: toNumber(form.value.reflectMaxFacts),
          ...(form.value.reflectKey.trim() ? { apiKey: form.value.reflectKey.trim() } : {}),
        },
        triage: {
          llmUrl: text(form.value.triageUrl),
          model: text(form.value.triageModel),
          ...(form.value.triageKey.trim() ? { apiKey: form.value.triageKey.trim() } : {}),
        },
      },
    })
    if (!result.ok) {
      error.value = result.error ?? t('settings.pages.modules.memory-api.save-failed')
      return
    }
    note.value = result.restartRequired
      ? t('settings.pages.modules.memory-api.saved-restart', { count: result.changed.length })
      : t('settings.pages.modules.memory-api.saved')
    await load()
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    saving.value = false
  }
}

async function clearKey(channel: 'embedding' | 'reflect' | 'triage') {
  saving.value = true
  try {
    await invokeSave({ patch: { [channel]: { clearApiKey: true } } })
    await load()
    note.value = t('settings.pages.modules.memory-api.key-cleared')
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    saving.value = false
  }
}

onMounted(() => {
  if (!PUBLIC_EDITION)
    return
  void load()
})
</script>

<template>
  <SettingsCard v-if="!PUBLIC_EDITION">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t('settings.pages.modules.memory-api.edition-private') }}
    </p>
  </SettingsCard>

  <div v-else :class="['flex flex-col', 'gap-4']">
    <SettingsCard>
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-api.lead') }}
      </p>
      <p v-if="snapshot" :class="['text-xs', 'text-neutral-400 dark:text-neutral-500', 'break-all']">
        {{ snapshot.bankDir }}
      </p>
      <p v-if="snapshot" :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
        {{ snapshot.configExists ? t('settings.pages.modules.memory-api.config-exists') : t('settings.pages.modules.memory-api.config-missing') }}
        · {{ snapshot.keysExists ? t('settings.pages.modules.memory-api.keys-exists') : t('settings.pages.modules.memory-api.keys-missing') }}
      </p>
      <p v-if="error" :class="['text-sm', 'text-red-500 dark:text-red-400']">
        {{ error }}
      </p>
      <p v-if="note" :class="['text-sm', 'text-emerald-600 dark:text-emerald-400']">
        {{ note }}
      </p>
    </SettingsCard>

    <SettingsCard>
      <h2 :class="['text-base', 'font-medium']">
        {{ t('settings.pages.modules.memory-api.embedding.title') }}
      </h2>
      <FieldSelect
        v-model="form.mode"
        :label="t('settings.pages.modules.memory-api.embedding.mode')"
        :description="t('settings.pages.modules.memory-api.embedding.mode-description')"
        :options="modeOptions"
      />
      <template v-if="form.mode === 'api'">
        <FieldInput
          v-model="form.apiUrl"
          :label="t('settings.pages.modules.memory-api.embedding.api-url')"
          placeholder="https://api.siliconflow.cn/v1"
        />
        <FieldInput
          v-model="form.apiModel"
          :label="t('settings.pages.modules.memory-api.embedding.api-model')"
          placeholder="BAAI/bge-m3"
        />
      </template>
      <template v-else-if="form.mode === 'ollama'">
        <FieldInput
          v-model="form.ollamaUrl"
          :label="t('settings.pages.modules.memory-api.embedding.ollama-url')"
          placeholder="http://127.0.0.1:11434"
        />
        <FieldInput
          v-model="form.model"
          :label="t('settings.pages.modules.memory-api.embedding.ollama-model')"
          placeholder="yuan-embedding-2.0-zh"
        />
      </template>
      <FieldInput
        :model-value="form.embeddingKey"
        :label="t('settings.pages.modules.memory-api.embedding.api-key')"
        :description="t('settings.pages.modules.memory-api.embedding.api-key-description')"
        type="password"
        autocomplete="off"
        @update:model-value="value => form.embeddingKey = value ?? ''"
      />
      <div :class="['flex', 'items-center', 'gap-3']">
        <span :class="['text-xs', snapshot?.embedding.hasApiKey ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400']">
          {{ snapshot?.embedding.hasApiKey ? t('settings.pages.modules.memory-api.key-set') : t('settings.pages.modules.memory-api.key-unset') }}
        </span>
        <button
          v-if="snapshot?.embedding.hasApiKey"
          type="button"
          :class="['text-xs', 'text-red-500', 'hover:underline']"
          @click="clearKey('embedding')"
        >
          {{ t('settings.pages.modules.memory-api.key-clear') }}
        </button>
      </div>
      <FieldInput
        v-model="form.dim"
        :label="t('settings.pages.modules.memory-api.embedding.dim')"
        :description="t('settings.pages.modules.memory-api.embedding.dim-description')"
        placeholder="1024"
      />
    </SettingsCard>

    <SettingsCard>
      <h2 :class="['text-base', 'font-medium']">
        {{ t('settings.pages.modules.memory-api.reflect.title') }}
      </h2>
      <p :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
        {{ t('settings.pages.modules.memory-api.reflect.description') }}
      </p>
      <FieldInput v-model="form.reflectUrl" :label="t('settings.pages.modules.memory-api.reflect.url')" placeholder="https://api.example.com/v1" />
      <FieldInput v-model="form.reflectModel" :label="t('settings.pages.modules.memory-api.reflect.model')" placeholder="deepseek-chat" />
      <FieldInput
        :model-value="form.reflectKey"
        :label="t('settings.pages.modules.memory-api.reflect.api-key')"
        type="password"
        autocomplete="off"
        @update:model-value="value => form.reflectKey = value ?? ''"
      />
      <div :class="['flex', 'items-center', 'gap-3']">
        <span :class="['text-xs', snapshot?.reflect.hasApiKey ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400']">
          {{ snapshot?.reflect.hasApiKey ? t('settings.pages.modules.memory-api.key-set') : t('settings.pages.modules.memory-api.key-unset') }}
        </span>
        <button
          v-if="snapshot?.reflect.hasApiKey"
          type="button"
          :class="['text-xs', 'text-red-500', 'hover:underline']"
          @click="clearKey('reflect')"
        >
          {{ t('settings.pages.modules.memory-api.key-clear') }}
        </button>
      </div>
      <FieldInput v-model="form.reflectMaxTokens" :label="t('settings.pages.modules.memory-api.reflect.max-tokens')" placeholder="32768" />
      <FieldInput
        v-model="form.reflectFactExtraction"
        :label="t('settings.pages.modules.memory-api.reflect.fact-extraction')"
        :description="t('settings.pages.modules.memory-api.reflect.fact-extraction-description')"
        placeholder="auto"
      />
      <FieldInput v-model="form.reflectMaxFacts" :label="t('settings.pages.modules.memory-api.reflect.max-facts')" placeholder="15" />
    </SettingsCard>

    <SettingsCard>
      <h2 :class="['text-base', 'font-medium']">
        {{ t('settings.pages.modules.memory-api.triage.title') }}
      </h2>
      <p :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
        {{ t('settings.pages.modules.memory-api.triage.description') }}
      </p>
      <FieldInput v-model="form.triageUrl" :label="t('settings.pages.modules.memory-api.triage.url')" placeholder="https://api.example.com/v1" />
      <FieldInput v-model="form.triageModel" :label="t('settings.pages.modules.memory-api.triage.model')" placeholder="deepseek-chat" />
      <FieldInput
        :model-value="form.triageKey"
        :label="t('settings.pages.modules.memory-api.triage.api-key')"
        type="password"
        autocomplete="off"
        @update:model-value="value => form.triageKey = value ?? ''"
      />
      <div :class="['flex', 'items-center', 'gap-3']">
        <span :class="['text-xs', snapshot?.triage.hasApiKey ? 'text-emerald-600 dark:text-emerald-400' : 'text-neutral-400']">
          {{ snapshot?.triage.hasApiKey ? t('settings.pages.modules.memory-api.key-set') : t('settings.pages.modules.memory-api.key-unset') }}
        </span>
        <button
          v-if="snapshot?.triage.hasApiKey"
          type="button"
          :class="['text-xs', 'text-red-500', 'hover:underline']"
          @click="clearKey('triage')"
        >
          {{ t('settings.pages.modules.memory-api.key-clear') }}
        </button>
      </div>
    </SettingsCard>

    <div :class="['flex', 'items-center', 'gap-3']">
      <button
        type="button"
        :disabled="saving || loading"
        :class="['rounded-lg', 'bg-primary-500', 'px-4', 'py-2', 'text-sm', 'text-white', 'disabled:opacity-50']"
        @click="save"
      >
        {{ saving ? t('settings.pages.modules.memory-api.saving') : t('settings.pages.modules.memory-api.save') }}
      </button>
      <span :class="['text-xs', 'text-neutral-400']">
        {{ t('settings.pages.modules.memory-api.restart-hint') }}
      </span>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-api.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
