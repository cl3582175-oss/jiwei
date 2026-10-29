import { defineConfig } from '@playwright/test'

// Browser-only production-component contracts must not run the Electron controlled
// setup: it injects out/main/index.js and would race an integration owner's build.
export default defineConfig({
  testDir: '..',
  testMatch: 'shadcn-ui.spec.ts',
  grep: /production component/,
  timeout: 30_000,
  workers: 1,
  reporter: 'list'
})
