import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Source-browser regression only: no Electron launch, build, or temp-data cleanup.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'shadcn-submenu.spec.ts',
  outputDir: join(tmpdir(), 'jiwei-shadcn-submenu-results'),
  timeout: 30_000,
  workers: 1,
  reporter: 'list'
})
