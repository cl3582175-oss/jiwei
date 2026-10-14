import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// 全量受控回归不得继承真实服务配置，真实/模型下载套件也不进入测试收集。
for (const name of [
  'JIWEI_IMPORT_PROVIDERS_FROM',
  'JIWEI_EVAL',
  'JIWEI_MOSS',
  'JIWEI_OCR',
  'JIWEI_ASR',
  'JIWEI_READING_REAL',
  'JIWEI_BACKUP_REAL',
  'JIWEI_VOICE_MODELS_APPDATA'
])
  process.env[name] = ''

export default defineConfig({
  ...base,
  testIgnore: [
    '**/fixtures/*.test.ts',
    '**/*-live.spec.ts',
    '**/*-real.spec.ts',
    '**/*-provider.spec.ts',
    '**/voice-models.spec.ts',
    '**/retrieval-eval.spec.ts',
    '**/web-eval.spec.ts',
    '**/ui-eval.spec.ts'
  ]
})
