import { cwd } from 'node:process'

import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import Info from 'unplugin-info/vite'
import VueRouter from 'vue-router/vite'

import { playwright } from '@vitest/browser-playwright'
import { mergeConfigs } from 'unocss'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

import { sharedUnoConfig } from '../../uno.config'

// UnoCSS globs need forward slashes. On Windows `import.meta.dirname` has
// backslashes, which fast-glob reads as escapes, so no file matches.
const projectDir = import.meta.dirname.replaceAll('\\', '/')

export default defineConfig({
  root: import.meta.dirname,
  // Shared settings pages import these optional UI dependencies through the
  // component barrel, and test Workers import the eventa Worker adapter.
  // Bundle them before a browser test starts to avoid HMR.
  optimizeDeps: {
    include: [
      '@moeru/eventa/adapters/webworkers',
      '@moeru/eventa/adapters/webworkers/worker',
      '@moeru/std',
      '@vueuse/core',
      'embla-carousel-vue',
      'html2canvas',
      'node-vibrant/browser',
      'reka-ui',
      'vaul-vue',
      'vue',
      'vue-i18n',
    ],
  },
  plugins: [
    Info(),
    // Use the app's route-block transform when browser tests mount shared pages.
    VueRouter({ routesFolder: [], dts: false }),
    Vue(),
    UnoCSS(mergeConfigs([sharedUnoConfig(), {
      // Browser tests use product styles, not Histoire's hover-preview variants.
      configFile: false,
      // Vitest loads components after the stylesheet. Scan their source before
      // the initial CSS response instead of relying on Vite's HMR updates.
      content: {
        filesystem: [
          `${projectDir}/src/**/*.vue`,
          `${projectDir}/../ui/src/**/*.vue`,
        ],
      },
    }])),
  ],
  test: {
    env: loadEnv('test', cwd(), ''),
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.browser.test.ts'],
          fileParallelism: false,
          hookTimeout: 20_000,
          maxWorkers: 1,
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts'],
          exclude: ['**/node_modules/**'],
          // Browser mode defaults to 15s. Files that mount Live2D need more
          // headroom when many browser files run at once.
          testTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } }),
            instances: [
              { browser: 'chromium' },
            ],
          },
        },
      },
    ],
  },
})
