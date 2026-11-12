import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import en from '@proj-airi/i18n/locales/en'

import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { page } from 'vitest/browser'
import { createI18n } from 'vue-i18n'

import StepCastaliaBasics from './step-castalia-basics.vue'

import { injectKeyPiniaSynced } from '../../../../libs/pinia/synced-context'
import { useMemoryStore } from '../../../../stores/memory'
import { SILENCE_KEY } from '../../../../stores/modules/self-initiated-speech'

import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'

/**
 * The last onboarding step answers three questions a new owner asks on day one: where her memory
 * lives, when she speaks first, and how to turn each off.
 *
 * The folder and the switches must be the real ones. A path that is not the folder the engine reads,
 * or a switch that only changes this window, is worse than no step: it teaches the wrong thing.
 */

/** The store reads the election at setup. The step never starts a ticker, so any leader works. */
function election(): SyncedPiniaRuntime {
  return {
    isLeader: () => true,
    onLeadershipChange: () => () => {},
  } as unknown as SyncedPiniaRuntime
}

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

afterEach(() => {
  localStorage.clear()
})

async function renderStep() {
  const pinia = createPinia()
  const onNext = vi.fn()
  const screen = await render(StepCastaliaBasics, {
    props: { onNext, onPrevious: vi.fn() },
    global: {
      plugins: [pinia, createTestI18n()],
      provide: { [injectKeyPiniaSynced as symbol]: election() },
    },
  })
  return { screen, pinia, onNext }
}

describe('onboarding memory and voice step', () => {
  it('shows the folder the main process reports, not a generic sentence', async () => {
    const { screen, pinia } = await renderStep()

    useMemoryStore(pinia).setBackend({
      transport: 'in-process',
      project: 'airi',
      character: 'airi',
      bankDir: 'D:\\castalia\\memory-banks',
      capabilities: {
        vadSweep: true,
        recall: true,
        search: true,
        facts: true,
        ingest: true,
        maintain: true,
        selfCycle: true,
        psyche: true,
      },
      checkedAt: Date.now(),
    })

    await expect.element(screen.getByText('D:\\castalia\\memory-banks')).toBeInTheDocument()
    await expect.element(screen.getByText('airi / airi', { exact: false })).toBeInTheDocument()
  })

  it('says where a browser keeps her memory, without inventing a folder', async () => {
    const { screen } = await renderStep()

    // The test runs as the web stage: a folder path here would point at a directory that never exists.
    await expect.element(screen.getByText('A browser has no folder to show. Her memory sits in this site\'s storage, and clearing site data erases it.')).toBeInTheDocument()
    await expect.element(screen.getByText('Every conversation she keeps stays in this browser. Nothing goes to us.')).toBeInTheDocument()
  })

  it('writes the silence key, so the ticker in the stage window sees the switch', async () => {
    const { screen } = await renderStep()

    await page.getByTestId('onboarding-voice-switch').click()

    // The key is what makes the switch outlive this window and this run: the leading window reads it
    // on every tick, and a restart reads it before the first tick.
    expect(localStorage.getItem(SILENCE_KEY)).toBe('true')
    await expect.element(screen.getByTestId('onboarding-voice-switch')).toHaveAttribute('data-state', 'unchecked')
  })

  it('turns long-term memory off through the same switch the settings page uses', async () => {
    const { pinia } = await renderStep()

    await page.getByTestId('onboarding-memory-switch').click()

    expect(useMemoryStore(pinia).enabled).toBe(false)
    expect(localStorage.getItem('memory/enabled')).toBe('false')
  })

  it('finishes the setup when the owner presses start', async () => {
    const { pinia, onNext } = await renderStep()

    await page.getByTestId('onboarding-castalia-start').click()

    expect(onNext).toHaveBeenCalledOnce()
    // 开关只在按下时写：没动过就不该留下任何持久化的值。
    expect(localStorage.getItem(SILENCE_KEY)).toBeNull()
    expect(useMemoryStore(pinia).enabled).toBe(true)
  })
})
