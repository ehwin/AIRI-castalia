<script setup lang="ts">
import { DropdownMenu } from '@proj-airi/ui'
import { DropdownMenuItem } from 'reka-ui'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

const { t } = useI18n()
</script>

<template>
  <div :class="['flex items-center gap-2']">
    <DropdownMenu
      align="end"
      :content-class="['w-60']"
      variant="blurry"
    >
      <template #trigger>
        <button
          type="button"
          :aria-label="t('settings.title')"
          :title="t('settings.title')"
          :class="[
            'group size-10 flex items-center justify-center rounded-full border-2 p-1 outline-none shadow-sm backdrop-blur-md',
            'border-neutral-100/60 bg-neutral-50/70 dark:border-neutral-800/30 dark:bg-neutral-800/70',
            'hover:bg-neutral-100 data-[state=open]:bg-neutral-100',
            'dark:hover:bg-neutral-800 dark:data-[state=open]:bg-neutral-800',
            'data-[state=open]:ring-2 data-[state=open]:ring-primary-500/20',
            'transition-colors duration-200 ease-in-out',
            'relative',
          ]"
        >
          <span
            :class="[
              'size-7 flex items-center justify-center rounded-full',
              'bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-300',
            ]"
          >
            <span :class="['i-solar:user-bold-duotone size-4']" aria-hidden="true" />
          </span>
          <div
            :class="[
              'i-solar:alt-arrow-down-linear text-neutral-400',
              'transition-transform duration-200',
              'group-data-[state=open]:rotate-180',
            ]"
          />
        </button>
      </template>

      <DropdownMenuItem as-child>
        <RouterLink
          to="/settings"
          :class="[
            'group w-full flex cursor-pointer select-none items-center gap-3 rounded-lg px-3 py-2',
            'text-sm leading-none outline-none text-neutral-700 dark:text-neutral-200',
            'data-[highlighted]:bg-primary-100/80 dark:data-[highlighted]:bg-primary-900/40',
            'transition-colors duration-150 ease-in-out',
          ]"
        >
          <span :class="['i-solar:settings-minimalistic-bold-duotone text-lg text-neutral-400 transition group-hover:text-primary-500']" aria-hidden="true" />
          {{ t('settings.title') }}
        </RouterLink>
      </DropdownMenuItem>
    </DropdownMenu>
  </div>
</template>
