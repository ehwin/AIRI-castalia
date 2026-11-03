import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

import stageUiConfig from '../../../../packages/stage-ui/vitest.config'

export default defineConfig({
  ...stageUiConfig,
  test: {
    ...stageUiConfig.test,
    projects: [
      {
        extends: true,
        test: {
          name: 'audit-browser',
          include: ['audits/castalia-link-review-2026-11-03.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
