import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/fixtures/*.test.ts'],
  globalSetup: './e2e/setup/cleanTemp.ts',
  timeout: 30_000,
  workers: 1,
  reporter: 'list'
})
