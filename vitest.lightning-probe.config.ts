import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: [],
    include: ['scripts/qualification/lightning-receive.probe.ts'],
    testTimeout: 30000,
  },
})
