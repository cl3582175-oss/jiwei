import { expect, it } from 'vitest'
import { neutralizeUiFences } from '../sanitize'

it.each([
  '```jiwei-ui',
  '````jiwei-ui',
  '~~~jiwei-ui',
  '  ``` JIWEI-UI',
  '```jiwei-ui title=hi',
  '```jiwei-ui-extra',
  '｀｀｀jiwei-ui',
  '&#96;&#96;&#96;jiwei-ui',
  '&#0096;&#x060;&#X60jiwei-ui',
  '&grave;&grave;&grave;JIWEI-UI',
  '> ```jiwei-ui',
  '- ```jiwei-ui',
  '1. ~~~jiwei-ui'
])('中和外部围栏 %s', (fence) => {
  expect(neutralizeUiFences(fence + '\n{}\n```').toLowerCase()).toContain('jiwei-ui-blocked')
})
it('普通代码不变，多次过滤结果相同', () => {
  const src = '```ts\nconst x = 1\n```\n\n```jiwei-ui\n{}\n```'
  const once = neutralizeUiFences(src)
  expect(once).toContain('```ts\nconst x = 1\n```')
  expect(neutralizeUiFences(once)).toBe(once)
})
