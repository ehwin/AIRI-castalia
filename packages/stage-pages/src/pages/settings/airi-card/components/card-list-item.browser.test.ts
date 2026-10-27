import en from '@proj-airi/i18n/locales/en'

import { DisplayModelFormat, useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { createPinia, disposePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import CardListItem from './card-list-item.vue'

import 'virtual:uno.css'

const props = {
  id: 'card',
  name: 'Luna',
  isActive: false,
  version: '1.0.0',
  modelId: 'model',
}

async function renderItem(isActive = false, modelId = props.modelId) {
  const pinia = createPinia()
  useDisplayModelsStore(pinia).displayModels = [{
    id: 'model',
    format: DisplayModelFormat.VRM,
    type: 'url',
    url: 'https://example.com/model.vrm',
    name: 'Avatar',
    previewImage: 'data:image/png;base64,preview',
    importedAt: 0,
  }]
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })

  return {
    pinia,
    screen: await render(CardListItem, {
      props: { ...props, isActive, modelId },
      global: {
        plugins: [
          pinia,
          createI18n({ legacy: false, locale: 'en', messages: { en } }),
          router,
        ],
      },
    }),
  }
}

describe('card list item', () => {
  afterEach(() => cleanup())

  it('shows the model cover and active badge', async () => {
    const { screen, pinia } = await renderItem(true)

    const image = screen.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,preview')
    await expect.element(screen.getByText('Currently Active')).toBeVisible()
    disposePinia(pinia)
  })

  it('shows the ghost placeholder with an accessible name when no model is selected', async () => {
    const { screen, pinia } = await renderItem(false, '')

    const placeholder = screen.container.querySelector('[role="img"]')
    expect(placeholder?.getAttribute('aria-label')).toBe('No model selected')
    expect(placeholder?.querySelector('svg[data-icon="ghost-smile-bold-duotone"]')).not.toBeNull()
    disposePinia(pinia)
  })
})
