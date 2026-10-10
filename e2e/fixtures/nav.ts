import type { Page } from '@playwright/test'

// v0.6.7 导航分组：今日 · 收集 · 学习 · 计划，积微助手在顶部。
// 目标按钮不在当前展开的组里时，先点它所在的组，再点它（已经在目标页时不重复点，以免关掉打开的笔记）。
const GROUPS: [RegExp, string][] = [
  [/收件箱|资料库|浏览|录音/, '收集'],
  [/笔记|复习|费曼|图谱/, '学习'],
  [/学习目标|复盘/, '计划'],
  [/今日/, '今日']
]

export async function navTo(page: Page, name: RegExp): Promise<void> {
  const rail = page.getByTestId('nav-rail')
  if (/AI 对话|积微助手/.test(name.source)) return rail.getByRole('button', { name: /^积微助手/ }).first().click()
  const button = rail.getByRole('button', { name }).first()
  if (await button.isVisible()) return button.click()
  const group = GROUPS.find(([pattern]) => pattern.test(name.source))
  if (!group) throw new Error(`Unknown navigation target ${name}`)
  await rail.getByRole('button', { name: new RegExp(`^${group[1]}`) }).first().click()
  if ((await button.getAttribute('aria-current').catch(() => null)) === 'page') return
  await button.click()
}
