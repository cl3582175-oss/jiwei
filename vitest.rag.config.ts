import { mergeConfig, defineConfig } from 'vitest/config'
import base from './vitest.config'

// A 线不能修改既有配置；显式纳入新增评测夹具测试，原有单元测试范围保持一致。
export default mergeConfig(
  base,
  defineConfig({
    test: { include: ['src/**/*.test.ts', 'e2e/fixtures/uiEval.test.ts', 'e2e/fixtures/rag*.test.ts'] }
  })
)
