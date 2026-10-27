import { resolve } from 'node:path'

import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import Info from 'unplugin-info/vite'
import VueRouter from 'vue-router/vite'

import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import { sharedUnoConfig } from '../../uno.config'

// UnoCSS globs need forward slashes. On Windows `import.meta.dirname` has
// backslashes, which fast-glob reads as escapes, so no file matches.
const projectDir = import.meta.dirname.replaceAll('\\', '/')

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    Info(),
    Vue(),
    VueRouter({
      extensions: ['.vue'],
      dts: false,
      routesFolder: resolve(import.meta.dirname, 'src', 'pages'),
      exclude: ['**/components/**', '**/*.test.ts'],
    }),
    UnoCSS({
      ...sharedUnoConfig(),
      configFile: false,
      content: {
        filesystem: [
          `${projectDir}/src/**/*.vue`,
          `${projectDir}/../stage-ui/src/**/*.vue`,
          `${projectDir}/../ui/src/**/*.vue`,
        ],
      },
    }),
  ],
  test: {
    include: ['src/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      // The Voiceprint page records from the microphone. Chromium then uses a fake device without a permission prompt.
      provider: playwright({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } }),
      instances: [
        { browser: 'chromium' },
      ],
    },
  },
})
