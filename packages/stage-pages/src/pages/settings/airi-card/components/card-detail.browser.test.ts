import en from '@proj-airi/i18n/locales/en'

import { useBackgroundStore } from '@proj-airi/stage-ui/stores/background'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'

import CardDetail from './card-detail.vue'

import 'virtual:uno.css'

describe('card detail', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    localStorage.clear()
    pinia = createPinia()
  })

  afterEach(() => {
    cleanup()
    disposePinia(pinia)
    localStorage.clear()
  })

  // The store calls `useI18n()` at its own setup, so the first call to
  // `useAiriCardStore` must happen while a component with the i18n plugin is
  // mounted. Mounting the detail on a placeholder id before the card exists
  // gives the store that context, and `rerender` then points it at the card.
  async function renderDetail() {
    const screen = await render(CardDetail, {
      props: { cardId: 'placeholder', initialTab: 'gallery' },
      global: {
        plugins: [pinia, createI18n({ legacy: false, locale: 'en', messages: { en } })],
      },
    })
    const cardId = await useAiriCardStore(pinia).addCard({ name: 'Luna', version: '1.0.0' })
    await screen.rerender({ cardId })
    return { screen, cardId }
  }

  it('pins a background to the card', async () => {
    const { screen, cardId } = await renderDetail()
    const backgroundStore = useBackgroundStore(pinia)
    const backgroundId = 'bg-test'
    await expect.poll(() => backgroundStore.loading).toBe(false)
    backgroundStore.entries = new Map([[backgroundId, {
      id: backgroundId,
      type: 'journal',
      characterId: cardId,
      title: 'Test image',
      blob: new Blob(['image'], { type: 'image/png' }),
      createdAt: 0,
    }]])
    await screen.rerender({ cardId })

    await expect.element(screen.getByRole('img', { name: 'Test image' })).toBeVisible()
    await screen.getByRole('button', { name: 'Set as background' }).click()

    await expect.poll(() => useAiriCardStore(pinia).cards.get(cardId)?.extensions.airi.modules.activeBackgroundId).toBe(backgroundId)
    backgroundStore.entries = new Map()
  })
})
