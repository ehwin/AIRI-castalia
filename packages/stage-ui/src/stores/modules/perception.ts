import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useVisionStore } from './vision'

/**
 * What the companion may look at.
 *
 * The screen pipeline already exists: a capture ticker feeds the vision
 * orchestrator, which runs a workload such as `screen:interpret` and turns the
 * frame into one line of text. The camera pipeline does not exist yet.
 *
 * The mind reads this through its `SensePort`, so the toggles here decide
 * whether a port is attached at all.
 */
export const usePerceptionStore = defineStore('perception', () => {
  /** Whether the companion may interpret screen frames. */
  const screen = useLocalStorageManualReset<boolean>('perception/screen', false)
  /** Whether the companion may use a camera. No pipeline reads it yet. */
  const camera = useLocalStorageManualReset<boolean>('perception/camera', false)

  const vision = useVisionStore()

  /** The screen pipeline needs a vision model, which the vision settings page configures. */
  const screenReady = computed(() => Boolean(vision.configured))
  const cameraReady = computed(() => false)

  /** True when at least one sense can be attached. */
  const anyEnabled = computed(() => (screen.value && screenReady.value) || (camera.value && cameraReady.value))

  function resetState() {
    screen.reset()
    camera.reset()
  }

  return {
    screen,
    camera,
    screenReady,
    cameraReady,
    anyEnabled,
    resetState,
  }
})
