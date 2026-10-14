import { expect, it } from 'vitest'
import { promptCatalog, uiModeFor } from '../promptCatalog'
import { UI_DEFAULTS } from '../settings'
import { UI_TYPES } from '../catalog'

it.each(['normal', 'rich'] as const)('组件提示 %s 保持字节稳定并满足预算', (mode) => {
  for (const zh of [true, false]) expect(promptCatalog(mode, zh, false)).toBe(promptCatalog(mode, zh, false))
  expect(promptCatalog(mode, true, false).length / 1.6).toBeLessThanOrEqual(mode === 'normal' ? 1800 : 2600)
  for (const item of UI_TYPES) expect(promptCatalog(mode, true, false)).toContain(`- ${item.type}：`)
})
it('本地模型目录只有四种，off 不增加任何提示', () => {
  expect(promptCatalog('off', true, false)).toBe('')
  const prompt = promptCatalog('normal', true, true)
  expect([...prompt.matchAll(/^- ([a-z]+)：/gm)].map((m) => m[1])).toEqual(['table', 'list', 'choice', 'chart'])
})
it.each([
  ['feynman', 'custom', { ...UI_DEFAULTS }, 'off'],
  ['reflection', 'custom', { ...UI_DEFAULTS }, 'off'],
  ['chat', 'custom', { ...UI_DEFAULTS, density: 'off' }, 'off'],
  ['chat', 'ollama', { ...UI_DEFAULTS }, 'off'],
  ['chat', 'ollama', { ...UI_DEFAULTS, localModels: 'normal' }, 'normal'],
  ['inline', 'ollama', { ...UI_DEFAULTS, localModels: 'normal', inline: false }, 'off'],
  ['chat', 'custom', { ...UI_DEFAULTS, density: 'rich' }, 'rich']
])('uiMode 规则 %s %s', (kind, provider, settings, expected) => {
  expect(uiModeFor(kind as 'chat', provider as 'custom', settings as typeof UI_DEFAULTS)).toBe(expected)
})
