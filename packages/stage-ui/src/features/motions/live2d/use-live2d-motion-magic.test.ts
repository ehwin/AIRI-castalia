import { neutralPose } from '@proj-airi/model-driver-magic-live2d'
import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

import { useLive2DMotionMagic } from './index'

function createDataset() {
  const samples = Array.from({ length: 180 }, (_, index) => {
    const phase = index / 30 * Math.PI * 2
    return {
      ...neutralPose,
      atMs: index * 34,
      headX: Math.sin(phase) * 0.5,
      headY: Math.cos(phase) * 0.25,
    }
  })
  return {
    durationMs: samples.at(-1)!.atMs,
    samples,
  }
}

describe('live2d MAGIC motion', () => {
  it('initializes from a dataset and changes seeds without Web Crypto', async () => {
    const scope = effectScope()
    const publishPose = vi.fn()
    const releasePose = vi.fn()
    let now = 0
    const motion = scope.run(() => useLive2DMotionMagic({
      dataset: createDataset(),
      publishPose,
      releasePose,
      now: () => ++now,
      random: () => 0.5,
    }))!

    await motion.initialize()
    motion.randomizeSeed()

    expect(motion.status.value).toBe('ready')
    expect(motion.model.value?.method).toBe('var')
    expect(motion.fitDurationMs.value).toBe(1)
    expect(motion.seed.value).toBe(2_147_483_648)
    expect(publishPose).not.toHaveBeenCalled()
    expect(releasePose).not.toHaveBeenCalled()

    scope.stop()
  })

  it('fits AR-HMM with the selected production settings', async () => {
    const scope = effectScope()
    const motion = scope.run(() => useLive2DMotionMagic({
      dataset: createDataset(),
      method: 'ar-hmm',
      arHmmSettings: { stateCount: 3, order: 4, noiseScale: 0.6 },
      publishPose: vi.fn(),
      releasePose: vi.fn(),
      now: () => 1,
      random: () => 0.5,
    }))!

    await motion.initialize()

    const model = motion.model.value
    expect(model?.method).toBe('ar-hmm')
    if (model?.method === 'ar-hmm') {
      expect(model.diagnostics.stateCount).toBe(3)
      expect(model.diagnostics.featureCount).toBe(1 + 4 * model.diagnostics.channelCount)
    }
    scope.stop()
  })
})
