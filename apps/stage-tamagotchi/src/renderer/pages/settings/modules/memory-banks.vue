<script setup lang="ts">
import type { CastaliaBankRow, CastaliaBankTree } from '../../../../shared/eventa/castalia-memory'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { FieldSelect, SettingsCard } from '@proj-airi/ui'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { castaliaBankDelete, castaliaBankEdit, castaliaBankSearch, castaliaBankTree } from '../../../../shared/eventa/castalia-memory'

// 跨库浏览原来只有 3348 那个控制台（`viz/server.mjs` + 静态页），app 只会打开浏览器。
// 推广版不该要求用户再跑一个 Node 服务，所以这里直接读写各分区的 memory.sqlite。
const { t } = useI18n()
/** 这两页只在公开版出现（构建时 `VITE_AIRI_EDITION=public`）；私有版用 3348 控制台。 */
const PUBLIC_EDITION = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AIRI_EDITION === 'public'
const invokeTree = useElectronEventaInvoke(castaliaBankTree)
const invokeSearch = useElectronEventaInvoke(castaliaBankSearch)
const invokeEdit = useElectronEventaInvoke(castaliaBankEdit)
const invokeDelete = useElectronEventaInvoke(castaliaBankDelete)

const tree = ref<CastaliaBankTree[]>([])
const rows = ref<CastaliaBankRow[]>([])
const loading = ref(false)
const error = ref('')
const note = ref('')

const bank = ref('')
const project = ref('')
const partition = ref('')
const query = ref('')
const editing = ref<{ row: CastaliaBankRow, text: string }>()

const bankOptions = computed(() => tree.value.map(item => ({ label: item.bank, value: item.bank })))
const projectOptions = computed(() => {
  const found = tree.value.find(item => item.bank === bank.value)
  return (found?.projects ?? []).map(item => ({ label: item.project, value: item.project }))
})
const partitionOptions = computed(() => {
  const found = tree.value.find(item => item.bank === bank.value)
  const proj = found?.projects.find(item => item.project === project.value)
  return [{ label: t('settings.pages.modules.memory-banks.all'), value: '' }]
    .concat((proj?.partitions ?? []).map(item => ({ label: `${item.partition} (${item.active}/${item.total})`, value: item.partition })))
})

function pickDefaults() {
  const first = tree.value[0]
  if (!first)
    return
  bank.value = first.bank
  project.value = first.projects[0]?.project ?? ''
  partition.value = ''
}

async function loadTree() {
  loading.value = true
  error.value = ''
  try {
    tree.value = await invokeTree()
    pickDefaults()
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    loading.value = false
  }
}

async function search() {
  loading.value = true
  error.value = ''
  note.value = ''
  try {
    rows.value = await invokeSearch({
      bank: bank.value || undefined,
      project: project.value || undefined,
      partition: partition.value || undefined,
      query: query.value.trim() || undefined,
      limit: 100,
    })
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    loading.value = false
  }
}

function startEdit(row: CastaliaBankRow) {
  editing.value = { row, text: row.text }
  note.value = ''
  error.value = ''
}

async function saveEdit() {
  const current = editing.value
  if (!current)
    return
  loading.value = true
  try {
    const result = await invokeEdit({
      bank: current.row.bank,
      project: current.row.project,
      partition: current.row.partition,
      id: current.row.id,
      text: current.text,
    })
    if (!result.ok) {
      error.value = result.error ?? t('settings.pages.modules.memory-banks.write-failed')
      return
    }
    editing.value = undefined
    note.value = t('settings.pages.modules.memory-banks.updated')
    await search()
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    loading.value = false
  }
}

async function remove(row: CastaliaBankRow) {
  note.value = ''
  error.value = ''
  loading.value = true
  try {
    const result = await invokeDelete({
      bank: row.bank,
      project: row.project,
      partition: row.partition,
      id: row.id,
    })
    if (!result.ok) {
      error.value = result.error ?? t('settings.pages.modules.memory-banks.write-failed')
      return
    }
    note.value = t('settings.pages.modules.memory-banks.deleted')
    await search()
  }
  catch (cause) {
    error.value = (cause as Error).message
  }
  finally {
    loading.value = false
  }
}

const stamp = (iso: string) => {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toLocaleString() : iso
}

onMounted(async () => {
  if (!PUBLIC_EDITION)
    return
  await loadTree()
  await search()
})
</script>

<template>
  <SettingsCard v-if="!PUBLIC_EDITION">
    <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
      {{ t('settings.pages.modules.memory-banks.edition-private') }}
    </p>
  </SettingsCard>

  <div v-else :class="['flex flex-col', 'gap-4']">
    <SettingsCard>
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-banks.lead') }}
      </p>
      <p v-if="error" :class="['text-sm', 'text-red-500 dark:text-red-400']">
        {{ error }}
      </p>
      <p v-if="note" :class="['text-sm', 'text-emerald-600 dark:text-emerald-400']">
        {{ note }}
      </p>
    </SettingsCard>

    <SettingsCard>
      <div :class="['flex', 'flex-wrap', 'items-end', 'gap-3']">
        <FieldSelect v-model="bank" :label="t('settings.pages.modules.memory-banks.bank')" :options="bankOptions" />
        <FieldSelect v-model="project" :label="t('settings.pages.modules.memory-banks.project')" :options="projectOptions" />
        <FieldSelect v-model="partition" :label="t('settings.pages.modules.memory-banks.partition')" :options="partitionOptions" />
      </div>
      <div :class="['flex', 'items-center', 'gap-3']">
        <input
          v-model="query"
          :placeholder="t('settings.pages.modules.memory-banks.search-placeholder')"
          :class="['flex-1', 'rounded-lg', 'border', 'border-neutral-200', 'bg-transparent', 'px-3', 'py-2', 'text-sm', 'dark:border-neutral-700']"
          @keyup.enter="search"
        >
        <button
          type="button"
          :disabled="loading"
          :class="['rounded-lg', 'bg-primary-500', 'px-4', 'py-2', 'text-sm', 'text-white', 'disabled:opacity-50']"
          @click="search"
        >
          {{ loading ? t('settings.pages.modules.memory-banks.searching') : t('settings.pages.modules.memory-banks.search') }}
        </button>
      </div>
      <p :class="['text-xs', 'text-neutral-400']">
        {{ t('settings.pages.modules.memory-banks.count', { count: rows.length }) }}
      </p>
    </SettingsCard>

    <SettingsCard v-for="row in rows" :key="`${row.bank}/${row.project}/${row.partition}/${row.id}`">
      <template v-if="editing && editing.row.id === row.id && editing.row.partition === row.partition">
        <textarea
          v-model="editing.text"
          :class="['w-full', 'min-h-40', 'rounded-lg', 'border', 'border-neutral-200', 'bg-transparent', 'p-3', 'text-sm', 'dark:border-neutral-700']"
        />
        <div :class="['flex', 'items-center', 'gap-3']">
          <button type="button" :class="['rounded-lg', 'bg-primary-500', 'px-3', 'py-1.5', 'text-sm', 'text-white']" @click="saveEdit">
            {{ t('settings.pages.modules.memory-banks.save') }}
          </button>
          <button type="button" :class="['text-sm', 'text-neutral-500']" @click="editing = undefined">
            {{ t('settings.pages.modules.memory-banks.cancel') }}
          </button>
        </div>
      </template>
      <template v-else>
        <p :class="['whitespace-pre-wrap', 'text-sm', 'text-neutral-800', 'dark:text-neutral-200']">
          {{ row.text.length > 600 ? `${row.text.slice(0, 600)}…` : row.text }}
        </p>
        <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2', 'text-xs', 'text-neutral-400']">
          <span>{{ row.bank }} / {{ row.project }} / {{ row.partition }}</span>
          <span v-if="row.memType">· {{ row.memType }}</span>
          <span v-if="row.characterId">· {{ row.characterId }}</span>
          <span v-if="row.source">· {{ row.source }}</span>
          <span>· {{ stamp(row.updatedAt) }}</span>
          <span v-if="!row.hasVector">· {{ t('settings.pages.modules.memory-banks.no-vector') }}</span>
        </div>
        <div :class="['flex', 'items-center', 'gap-3']">
          <button type="button" :class="['text-xs', 'text-primary-600', 'hover:underline']" @click="startEdit(row)">
            {{ t('settings.pages.modules.memory-banks.edit') }}
          </button>
          <button type="button" :class="['text-xs', 'text-red-500', 'hover:underline']" @click="remove(row)">
            {{ t('settings.pages.modules.memory-banks.delete') }}
          </button>
        </div>
      </template>
    </SettingsCard>

    <SettingsCard v-if="!loading && rows.length === 0">
      <p :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-banks.empty') }}
      </p>
    </SettingsCard>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory-banks.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
