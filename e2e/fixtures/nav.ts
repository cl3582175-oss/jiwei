import { expect, type Page } from '@playwright/test'

// 导航（v0.7.4 浮卡）：今日 · 收集 · 学习 · 创作（v0.9）· 计划，积微助手在顶部。
// 二级入口在组图标右侧的浮卡里：先悬停组图标，再点浮卡中的目标（已经在目标页时不重复点，以免关掉打开的笔记）。
const GROUPS: [RegExp, string][] = [
  [/收件箱|资料库|浏览|录音/, '收集'],
  [/笔记|复习|费曼|图谱/, '学习'],
  [/参谋|作品/, '创作'],
  [/日历|方向|复盘/, '计划'],
  [/今日/, '今日']
]

/** again：已经在目标页时也再点一次（如再点“笔记”回到笔记主页） */
export async function navTo(page: Page, name: RegExp, opts: { again?: boolean } = {}): Promise<void> {
  const rail = page.getByTestId('nav-rail')
  if (/AI 对话|积微助手/.test(name.source)) return rail.getByRole('button', { name: /^积微助手/ }).first().click()
  const group = GROUPS.find(([pattern]) => pattern.test(name.source))
  if (!group) {
    const button = rail.getByRole('button', { name }).first()
    if (await button.isVisible()) return button.click()
    throw new Error(`Unknown navigation target ${name}`)
  }
  const groupButton = rail.getByRole('button', { name: new RegExp(`^${group[1]}`) }).first()
  if (group[1] === '今日') return groupButton.click()
  // 鼠标可能还停在组图标上（上一次按 Esc 收起后）：先移开，悬停才会重新展开
  await page.mouse.move(600, 4)
  await groupButton.hover()
  const ring = page.getByTestId('nav-ring')
  await expect(ring).toBeVisible()
  const item = ring.getByRole('menuitem', { name }).first()
  if (!opts.again && (await item.getAttribute('aria-current')) === 'page') {
    await page.keyboard.press('Escape')
    await expect(ring).toHaveCount(0)
    return
  }
  await item.click()
  await expect(ring).toHaveCount(0)
}

/** 当前所在的二级页面：组图标的名称为“收集 · 资料库” */
export function currentNav(page: Page, group: string, item: string) {
  return page.getByTestId('nav-rail').getByRole('button', { name: new RegExp(`^${group} · ${item}`) })
}
