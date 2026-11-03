import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: {
    include: [
      'packages/castalia-plugin/audits/castalia-link-review-2026-11-03.test.ts',
      'packages/stage-ui/audits/castalia-link-review-2026-11-03.test.ts',
      'apps/stage-tamagotchi/audits/castalia-link-review-2026-11-03.test.ts',
    ],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
})
