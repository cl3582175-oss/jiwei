import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '..',
  testMatch: 'sidebar-browser.spec.ts',
  timeout: 15_000,
  workers: 1,
  reporter: 'list'
})
