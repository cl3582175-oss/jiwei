import { expect, it } from 'vitest'
import { modelContextLength } from '../modelContext'
it('使用已记录常用模型的保守窗口，未知或本地Ollama型号不猜大窗口', () => {
  expect(modelContextLength('deepseek', 'deepseek-flash')).toBe(128000)
  expect(modelContextLength('deepseek', 'deepseek-v4-pro')).toBe(128000)
  expect(modelContextLength('openai', 'gpt-4.1')).toBe(128000)
  expect(modelContextLength('qwen', 'qwen-plus')).toBe(32768)
  expect(modelContextLength('anthropic', 'claude-sonnet-4-5')).toBe(200000)
  expect(modelContextLength('google', 'gemini-2.5-pro')).toBe(1048576)
  expect(modelContextLength('ollama', 'deepseek-r1:latest')).toBe(8192)
  expect(modelContextLength('openai', 'controlled-test')).toBe(8192)
})
