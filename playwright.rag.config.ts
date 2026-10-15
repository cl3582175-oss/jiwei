import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// 真实评测库需要重开；不执行默认的过期 jiwei-* 临时目录清理，避免影响并行审查。
export default defineConfig({
  ...base,
  globalSetup: undefined,
  workers: 1,
  retries: 0,
  outputDir: '.superpowers/sdd/v0.14.5-knowledge-retrieval/playwright-results'
})
