import type { SettingsSearchModule } from '@proj-airi/stage-ui/libs/settings-search'

import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'

import { moduleModelItems, speechVoiceItems } from './module-model-search'

/**
 * The speech page, with its speech providers, their models, and their voices. The page offers the same providers as cards.
 *
 * The official speech card and its streaming twin went with the hosted provider, so each provider
 * names its own card now and the search helpers keep their default identity mapping.
 */
export default {
  routes: [{
    path: '/settings/modules/speech',
    items: async () => {
      const providers = useProviderStore().moduleSpeechProvidersMetadata.filter(provider => provider.id !== 'speech-noop')
      // The voices of a provider with a catalog for each model need its model list, so the models load first.
      const models = await moduleModelItems('speech', providers)
      return [...models, ...await speechVoiceItems(providers)]
    },
  }],
} satisfies SettingsSearchModule
