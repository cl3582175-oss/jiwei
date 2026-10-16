import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['local-compute.spec.ts', 'voice-models.spec.ts'],
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/local-compute',
  use: { trace: 'retain-on-failure' }
})
