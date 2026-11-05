import en from '@proj-airi/i18n/locales/en'

import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import IconStatusItem from './icon-status-item.vue'

import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

const DETAIL = 'in-process · airi/airi-1 · 记忆在线 · 情感经显式写入 · PSYCHE_FROM_VAD 未开启'

function createI18nForTest() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function createRouterForTest() {
  const blank = { template: '<div />' }
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: blank }, { path: '/target', component: blank }],
  })
}

async function renderItem(overrides: Record<string, unknown> = {}) {
  return await render(IconStatusItem, {
    props: {
      title: 'Long-term memory',
      description: 'Remember things across sessions',
      to: '/target',
      configured: true,
      ...overrides,
    },
    global: { plugins: [createI18nForTest(), createRouterForTest()] },
  })
}

describe('icon status item', () => {
  // The module list put the backend status on the card face, so two rows of long sentences made
  // the list hard to scan. The status belongs behind the card's own menu.
  it('keeps the backend status off the card face until its menu opens', async () => {
    const screen = await renderItem({ detail: DETAIL })

    await expect.element(screen.getByText('Long-term memory')).toBeVisible()
    expect(screen.getByText(DETAIL).query()).toBeNull()

    await screen.getByLabelText('Runtime status').click()

    await expect.element(screen.getByText(DETAIL)).toBeVisible()
  })

  it('shows no menu button when the module has no backend status', async () => {
    const screen = await renderItem()

    await expect.element(screen.getByText('Long-term memory')).toBeVisible()
    expect(screen.getByLabelText('Runtime status').query()).toBeNull()
  })
})
