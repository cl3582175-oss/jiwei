import { defineConfig } from '@playwright/test'
import base from './playwright.config'

export default defineConfig({
  ...base,
  // 本轮需保留旧版本复现证据，也不能清理其他正在工作的 chat 的临时资料库。
  globalSetup: undefined,
  testMatch: [
    '**/scanned-pdf.spec.ts',
    '**/assistant-ux.spec.ts',
    '**/attachments.spec.ts',
    '**/recognize.spec.ts',
    '**/rag-readiness.spec.ts',
    '**/rag-pdf-runtime.spec.ts'
  ],
  outputDir: '.superpowers/sdd/v0.14.10-scanned-pdf/test-results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
})
