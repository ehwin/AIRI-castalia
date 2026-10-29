<script setup lang="ts">
import { useCharacterStore } from '@proj-airi/stage-ui/stores/characters'
import { computed, onMounted } from 'vue'

const characterStore = useCharacterStore()

const coverImage = new URL('../../../../stage-ui/src/components/menu/relu.avif', import.meta.url).href
const characterAvatarImage = new URL('../../../../stage-ui/src/assets/live2d/models/hiyori/preview.png', import.meta.url).href

onMounted(() => {
  characterStore.fetchList()
})

const characters = computed(() => Array.from(characterStore.characters.values()).map((char) => {
  const i18n = char.i18n?.[0] || { name: 'Unknown', tagline: '', description: '' }

  return {
    id: char.id,
    name: i18n.name,
    tagline: i18n.tagline || i18n.description,
    avatarUrl: char.avatarUrl || 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=200&q=80',
    characterAvatarUrl: char.characterAvatarUrl || characterAvatarImage,
    coverUrl: char.coverUrl || coverImage,
    coverBackgroundUrl: char.coverBackgroundUrl,
  }
}))
</script>

<template>
  <div :class="['min-h-screen w-full']">
    <div>
      <div :class="['mt-10 grid gap-6', 'sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5']">
        <article
          v-for="character in characters"
          :key="character.id"
          :class="[
            'group relative rounded-3xl overflow-hidden',
            'shadow-sm',
            '[&_.character-card-buttons-more]:opacity-0 [&_.character-card-buttons-more]:hover:opacity-100',
            'aspect-[12/19]',
          ]"
        >
          <div :class="['relative overflow-hidden w-full h-70% rounded-2xl']">
            <img
              v-if="character.coverBackgroundUrl"
              :src="character.coverBackgroundUrl"
              :alt="character.name"
              :class="[
                'absolute inset-0 z-5',
                'w-full h-full',
                'object-cover',
              ]"
            >
            <div
              v-else
              :class="[
                'absolute inset-0 z-5',
                'w-full h-full',
                'bg-white',
              ]"
            />
            <img
              :src="character.coverUrl"
              :alt="character.name"
              :class="[
                'absolute left-0 top-0 z-5',
                'h-full w-full',
                'object-cover',
                'transition duration-300 ease-in-out',
              ]"
            >
            <!-- Dropdown -->
            <button
              type="button"
              :class="[
                'character-card-buttons-more',
                'absolute right-3 top-3 z-6',
                'h-7 w-7',
                'flex items-center justify-center',
                'rounded-lg backdrop-blur-sm',
                'text-white',
                'bg-neutral-900/30 hover:bg-neutral-900/45 active:bg-neutral-900/60',
                'dark:bg-neutral-950/50 hover:dark:bg-neutral-900/65 active:dark:bg-neutral-900/90',
                'transition duration-200 ease-in-out',
              ]"
              aria-label="Options for character"
            >
              <div :class="['i-solar-menu-dots-bold inline-block']" />
            </button>
          </div>

          <div :class="['relative z-7 overflow-hidden h-30%']">
            <div class="relative z-1 h-full">
              <div class="relative h-full flex flex-col justify-between gap-2 px-3 pb-3 pt-2">
                <div :class="['flex items-center gap-2']">
                  <div :class="['flex items-center gap-2']">
                    <img
                      :src="character.characterAvatarUrl"
                      :alt="character.name"
                      :class="['h-7 w-7 rounded-full object-cover']"
                    >
                    <div :class="['text-lg font-semibold line-clamp-1']">
                      {{ character.name }}
                    </div>
                  </div>
                </div>
                <div :class="['flex-1 text-xs text-ellipsis text-neutral-500 line-clamp-3 max-h-[3rem] overflow-hidden']">
                  {{ character.tagline }}
                </div>
                <div :class="['flex items-center justify-end']">
                  <div
                    :class="[
                      'flex flex-row items-center gap-1',
                      'pl-1.5 pr-2 py-1 rounded-full',
                      'bg-neutral-900/50',
                    ]"
                  >
                    <div
                      :class="[
                        'i-ph:plus-bold',
                        'text-xs inline-block',
                        'text-neutral-100 dark:text-neutral-900',
                      ]"
                    />
                    <span
                      :class="[
                        'text-xs',
                        'text-neutral-100 dark:text-neutral-900',
                      ]"
                    >
                      Chat
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div :class="['absolute left-0 top-0 z-0 w-full h-full']">
            <div :class="['absolute inset-0 z-2 bg-white/70 backdrop-blur-lg w-full h-full']" />
            <img
              :src="character.coverUrl"
              :alt="character.name"
              :class="[
                'relative z-1',
                'h-full w-full',
                'object-contain',
                'transition duration-300 ease-in-out',
                'scale-300 group-hover:scale-350',
              ]"
            >
          </div>
        </article>
      </div>
    </div>
  </div>
</template>
