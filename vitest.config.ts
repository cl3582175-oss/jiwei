import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['src/**/*.test.ts', 'e2e/fixtures/uiEval.test.ts'], environment: 'node' }
})
