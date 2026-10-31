<script setup lang="ts">
import type { CastaliaFullHit, CastaliaFullMember } from '../../../../shared/eventa/castalia-memory'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { castaliaFullMembers, castaliaFullSearch, castaliaMemoryMaintain, castaliaOpenConsole } from '../../../../shared/eventa/castalia-memory'

// NOTICE: 这个页面在 app 里覆盖了 stage-pages 的同名 WIP 页（见 electron.vite.config.ts 的 exclude）。
// 边界: 「记忆体」= Full 总线（跨库只读总览/检索）；「长期记忆」= castalia 本库（进程内插件）。
// 总线没起时页面只显示离线提示，不阻塞其它设置页。

const { t } = useI18n()
const KEY = 'settings.pages.memory.bus'
const invokeMembers = useElectronEventaInvoke(castaliaFullMembers)
const invokeSearch = useElectronEventaInvoke(castaliaFullSearch)
const invokeOpenConsole = useElectronEventaInvoke(castaliaOpenConsole)

const consoleNote = ref('')

/**
 * 记忆维护手动入口：抽取 + 整合 + digest 都在主进程内跑（app ↔ anima 两段），
 * 平时由主进程按天自动跑一次，这里只是「现在就跑一次」。
 */
const invokeMaintain = useElectronEventaInvoke(castaliaMemoryMaintain)
const maintaining = ref(false)
const maintainNote = ref('')

async function maintainNow() {
  if (maintaining.value)
    return
  maintaining.value = true
  maintainNote.value = ''
  try {
    const report = await invokeMaintain({ limit: 30 })
    const reflect = report.reflect as Record<string, any> | undefined
    const merged = report.consolidate as Record<string, any> | undefined
    if (!report.reflectConfigured) {
      maintainNote.value = `${t(`${KEY}.maintain_no_llm`)}`
    }
    else if (!report.ok) {
      maintainNote.value = `${t(`${KEY}.maintain_failed`)}: ${report.error ?? (reflect?.errors ?? []).join('; ')}`
    }
    else {
      maintainNote.value = [
        `${t(`${KEY}.maintain_done`)}`,
        `${t(`${KEY}.maintain_facts`)} +${reflect?.factsInserted ?? 0}`,
        `${t(`${KEY}.maintain_merged`)} ${merged?.merged ?? 0}`,
        `${Math.round((report.ms ?? 0) / 1000)}s`,
      ].join(' · ')
    }
  }
  catch (error) {
    maintainNote.value = (error as Error).message
  }
  finally {
    maintaining.value = false
  }
}

/** 跨库浏览的完整 UI 在控制台的「记忆总成」里；这里只负责把窗口切过去。 */
async function openConsole(view: 'agg' | 'mng' | 'viz') {
  try {
    const result = await invokeOpenConsole({ view })
    consoleNote.value = result.ok
      ? (result.via === 'shell' ? 'opened-shell' : 'opened-browser')
      : 'failed'
  }
  catch (error) {
    consoleNote.value = (error as Error).message
  }
}

const members = ref<CastaliaFullMember[]>([])
const total = ref(0)
const reason = ref('')
const loadingMembers = ref(false)
const loading = ref(false)
const query = ref('')
const hits = ref<CastaliaFullHit[]>([])
const searched = ref(false)
const scope = ref<string[]>([])

const offline = computed(() => reason.value.length > 0)
const totalLabel = computed(() => t(`${KEY}.total`, { count: total.value.toLocaleString() }))

async function refresh() {
  loadingMembers.value = true
  try {
    const result = await invokeMembers()
    members.value = result.members ?? []
    total.value = result.totalMemories ?? 0
    reason.value = result.ok ? '' : (result.error ?? 'unknown')
  }
  catch (error) {
    members.value = []
    total.value = 0
    reason.value = (error as Error).message || 'unknown'
  }
  finally {
    loadingMembers.value = false
  }
}

async function runSearch() {
  const text = query.value.trim()
  if (!text)
    return
  loading.value = true
  searched.value = true
  try {
    const result = await invokeSearch({ query: text, topK: 10, ...(scope.value.length ? { members: scope.value } : {}) })
    hits.value = result.results ?? []
    if (!result.ok)
      reason.value = result.error ?? 'unknown'
    else
      reason.value = ''
  }
  catch (error) {
    hits.value = []
    reason.value = (error as Error).message || 'unknown'
  }
  finally {
    loading.value = false
  }
}

function toggleScope(id: string) {
  scope.value = scope.value.includes(id) ? scope.value.filter(item => item !== id) : [...scope.value, id]
}

function snippet(text: string) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat
}

onMounted(refresh)
</script>

<template>
  <div :class="['flex flex-col', 'gap-4']">
    <div :class="['flex items-start', 'gap-3']">
      <p :class="['min-w-0 flex-1', 'text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t(`${KEY}.description`) }}
      </p>
      <button
        type="button"
        :class="['shrink-0', 'rounded-lg', 'px-3 py-1.5', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700', 'disabled:opacity-50']"
        :disabled="loadingMembers"
        @click="refresh"
      >
        {{ t(`${KEY}.refresh`) }}
      </button>
    </div>

    <div :class="['flex flex-wrap items-center', 'gap-2']">
      <button
        type="button"
        :class="['rounded-lg', 'px-4 py-2', 'text-sm', 'font-medium', 'bg-primary-500 text-white', 'hover:bg-primary-600']"
        @click="openConsole('agg')"
      >
        {{ t(`${KEY}.open_console`) }}
      </button>
      <button
        type="button"
        :class="['rounded-lg', 'px-3 py-2', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700']"
        @click="openConsole('mng')"
      >
        {{ t(`${KEY}.manage`) }}
      </button>
      <button
        type="button"
        :class="['rounded-lg', 'px-3 py-2', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700']"
        @click="openConsole('viz')"
      >
        {{ t(`${KEY}.star_map`) }}
      </button>
      <button
        type="button"
        :disabled="maintaining"
        :class="['rounded-lg', 'px-3 py-2', 'text-xs', 'bg-neutral-100 dark:bg-neutral-800', 'hover:bg-neutral-200 dark:hover:bg-neutral-700', maintaining ? 'opacity-60' : '']"
        @click="maintainNow()"
      >
        {{ maintaining ? t(`${KEY}.maintaining`) : t(`${KEY}.maintain_now`) }}
      </button>
      <span v-if="consoleNote === 'opened-shell'" :class="['text-xs', 'text-neutral-400']">{{ t(`${KEY}.opened_shell`) }}</span>
      <span v-else-if="consoleNote === 'opened-browser'" :class="['text-xs', 'text-neutral-400']">{{ t(`${KEY}.opened_browser`) }}</span>
      <span v-else-if="consoleNote && consoleNote !== 'failed'" :class="['text-xs', 'text-amber-600']">{{ consoleNote }}</span>
    </div>

    <p v-if="maintainNote" :class="['text-xs', 'text-neutral-500 dark:text-neutral-400']">
      {{ maintainNote }}
    </p>

    <p :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
      {{ t(`${KEY}.open_hint`) }}
    </p>

    <div
      v-if="offline"
      :class="['rounded-xl', 'border', 'border-amber-300/60 dark:border-amber-500/40', 'bg-amber-50 dark:bg-amber-500/10', 'p-3', 'text-xs', 'text-amber-700 dark:text-amber-300']"
    >
      {{ t(`${KEY}.offline`, { reason }) }}
    </div>

    <section :class="['flex flex-col', 'gap-2', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-4']">
      <header :class="['flex items-baseline', 'gap-2']">
        <h2 :class="['text-sm font-medium']">
          {{ t(`${KEY}.title`) }}
        </h2>
        <span :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">{{ totalLabel }}</span>
      </header>

      <div :class="['flex flex-wrap', 'gap-2']">
        <button
          v-for="member in members"
          :key="member.id"
          type="button"
          :class="[
            'rounded-full', 'px-3 py-1', 'text-xs', 'transition-colors',
            scope.includes(member.id)
              ? 'bg-primary-500 text-white'
              : 'bg-neutral-100 dark:bg-neutral-700/70 hover:bg-neutral-200 dark:hover:bg-neutral-700',
          ]"
          :title="member.target"
          @click="toggleScope(member.id)"
        >
          {{ member.label || member.id }}
          <span :class="['ml-1', scope.includes(member.id) ? 'text-white/80' : 'text-neutral-400 dark:text-neutral-500']">{{ member.memories ?? 0 }}</span>
        </button>
        <span v-if="!members.length && !loadingMembers" :class="['text-xs', 'text-neutral-400']">—</span>
      </div>
    </section>

    <div :class="['flex items-center', 'gap-2']">
      <input
        v-model="query"
        type="search"
        :placeholder="t(`${KEY}.search_placeholder`)"
        :class="['min-w-0 flex-1', 'rounded-lg', 'border', 'border-neutral-200 dark:border-neutral-700', 'bg-white dark:bg-neutral-900', 'px-3 py-2', 'text-sm', 'outline-none', 'focus:border-primary-400']"
        @keyup.enter="runSearch"
      >
      <button
        type="button"
        :class="['shrink-0', 'rounded-lg', 'px-4 py-2', 'text-sm', 'bg-primary-500 text-white', 'hover:bg-primary-600', 'disabled:opacity-50']"
        :disabled="loading || !query.trim()"
        @click="runSearch"
      >
        {{ loading ? t(`${KEY}.searching`) : t(`${KEY}.search`) }}
      </button>
    </div>

    <p v-if="!searched" :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
      {{ t(`${KEY}.empty_hint`) }}
    </p>
    <p v-else-if="!hits.length && !loading" :class="['text-xs', 'text-neutral-400 dark:text-neutral-500']">
      {{ t(`${KEY}.no_results`) }}
    </p>

    <ul v-if="hits.length" :class="['flex flex-col', 'gap-2']">
      <li
        v-for="hit in hits"
        :key="`${hit.instance}:${hit.score}:${hit.text.slice(0, 24)}`"
        :class="['flex flex-col', 'gap-1', 'rounded-xl', 'bg-neutral-50 dark:bg-neutral-800/60', 'p-3']"
      >
        <div :class="['flex items-center', 'gap-2', 'text-xs', 'text-neutral-400 dark:text-neutral-500']">
          <span :class="['rounded-md', 'bg-neutral-200/70 dark:bg-neutral-700', 'px-1.5 py-0.5', 'text-[11px]']">{{ hit.instance }}</span>
          <span v-if="hit.memType">{{ hit.memType }}</span>
          <span :class="['ml-auto']">{{ t(`${KEY}.score`) }} {{ hit.score.toFixed(3) }}</span>
        </div>
        <p :class="['text-sm', 'leading-relaxed', 'whitespace-pre-wrap break-words']">
          {{ snippet(hit.text) }}
        </p>
      </li>
    </ul>

  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.memory.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.memory.description
  icon: i-solar:leaf-bold-duotone
  settingsEntry: true
  order: 5
  stageTransition:
    name: slide
</route>
