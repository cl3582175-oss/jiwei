import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 笔记修订（不需要 API Key）：AI 的替换 / 删除提案以行内差异显示，逐条接受或拒绝；选区浮条中的 AI 菜单。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let noteId = ''
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-revise-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

/** 当前笔记中某段文字所在块的 ID */
const blockIdOf = (text: string): Promise<string> =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll('.cornell-doc [data-id]')].find((e) => e.textContent === t && e.tagName === 'P')
    return el!.getAttribute('data-id')!
  }, text)

test('write a note', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('修订测试')
  await page.keyboard.press('Enter')
  await page.keyboard.type('间隔重复是一种非常非常有用的、被很多人使用的记忆方法，它的核心是在快要忘记的时候进行复习。')
  await page.keyboard.press('Enter')
  await page.keyboard.type('这一段准备删除。')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '修订测试' }).then((n) => n.length))).toBeGreaterThan(0)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '修订测试' }).then((n) => n[0].id))
})

test('AI replace / delete proposals appear as inline diffs', async () => {
  const keep = await blockIdOf('间隔重复是一种非常非常有用的、被很多人使用的记忆方法，它的核心是在快要忘记的时候进行复习。')
  const drop = await blockIdOf('这一段准备删除。')
  await page.evaluate(
    ({ noteId, keep, drop }) =>
      window.jiwei.proposals.create({
        noteId,
        title: '精简',
        ops: [
          {
            op: 'replace_block',
            blockId: keep,
            nodes: [{ type: 'paragraph', content: [{ type: 'text', text: '间隔重复是常用的记忆方法：在快要忘记时复习。' }] }]
          },
          { op: 'delete_block', blockId: drop }
        ]
      }),
    { noteId, keep, drop }
  )
  const cards = page.getByRole('group', { name: /AI 建议/ })
  await expect(cards).toHaveCount(2)
  const first = cards.first()
  await expect(first.locator('del').first()).toBeVisible()
  await expect(first.locator('ins').first()).toBeVisible()
  await expect(cards.nth(1)).toContainText('删除这个段落')
  // 行内显示的提案不再出现在顶部面板
  await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
  if (shots) await page.screenshot({ path: join(shots, '93-inline-diff.png') })

  // 接受替换
  await first.getByRole('button', { name: '接受' }).click()
  await expect(page.locator('.cornell-doc')).toContainText('间隔重复是常用的记忆方法：在快要忘记时复习。')
  await expect(page.locator('.cornell-doc')).not.toContainText('非常非常有用')
  // 拒绝删除
  await expect(cards).toHaveCount(1)
  await cards.first().getByRole('button', { name: '拒绝' }).click()
  await expect(cards).toHaveCount(0)
  await expect(page.locator('.cornell-doc')).toContainText('这一段准备删除。')
  // 被接受的内容标记为 AI 生成，可撤销
  await page.keyboard.press('ControlOrMeta+z')
})

test('selection toolbar has the AI edit menu', async () => {
  const p = page.locator('.cornell-doc p', { hasText: '这一段准备删除。' })
  await p.click({ clickCount: 3 })
  const bar = page.getByRole('button', { name: 'AI 修改' })
  await expect(bar).toBeVisible()
  await bar.click()
  const menu = page.getByRole('menu', { name: 'AI 修改' })
  await expect(menu.getByRole('menuitem')).toHaveText(['精简', '扩写', '改得通俗', '纠错', '改成要点列表', '告诉 AI 怎么改…', '解释', '讲给 AI 听（费曼）'])
  if (shots) await page.screenshot({ path: join(shots, '94-ai-menu.png') })
  // 自定义指令：打开输入卡片（未配置模型时不会发送）
  await menu.getByRole('menuitem', { name: '告诉 AI 怎么改…' }).click()
  await expect(page.getByRole('dialog', { name: '就地答复' }).getByRole('textbox', { name: /怎么改/ })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('mind map: edit in mind-elixir, anchors survive, AI edit opens a prompt', async () => {
  await page.evaluate(
    (noteId) =>
      window.jiwei.proposals.create({
        noteId,
        title: '导图',
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [{ type: 'paragraph', content: [{ type: 'text', text: '学习方法' }] }],
            body: [{ type: 'embed', attrs: { id: 'mm', kind: 'mindmap' } }]
          }
        ],
        embeds: {
          mm: {
            kind: 'mindmap',
            data: {
              root: 'r',
              nodes: {
                r: { text: '学习方法', parent: null, order: 0 },
                a: { text: '间隔重复', parent: 'r', order: 0, anchor: { type: 'segment', id: 'seg-1' } },
                b: { text: '提取练习', parent: 'r', order: 1 }
              }
            }
          }
        }
      }),
    noteId
  )
  await page.getByRole('button', { name: '全部接受' }).click()
  const block = page.locator('.embed-block[data-kind="mindmap"]')
  await expect(block.locator('svg.mindmap-svg')).toContainText('提取练习')

  // 编辑：给“提取练习”添加子节点
  await block.hover()
  await block.getByRole('button', { name: '编辑导图' }).click()
  const editor = page.getByTestId('mindmap-editor')
  await expect(editor.locator('me-tpc', { hasText: '提取练习' })).toBeVisible()
  await editor.locator('me-tpc', { hasText: '提取练习' }).click()
  await page.keyboard.press('Tab')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('主动回忆')
  await page.keyboard.press('Enter')
  await expect(editor.locator('me-tpc', { hasText: '主动回忆' })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '95-mindmap-editor.png') })
  await page.getByRole('button', { name: '保存' }).click()
  await expect(block.locator('svg.mindmap-svg')).toContainText('主动回忆')
  // 修改进入派生数据（检索、RAG）
  await expect.poll(async () => JSON.stringify(await page.evaluate((id) => window.jiwei.notes.blocks(id), noteId))).toContain('主动回忆')

  // AI 修改：打开指令输入卡片
  await block.hover()
  await block.getByRole('button', { name: 'AI 修改导图' }).click()
  await expect(page.getByRole('dialog', { name: '就地答复' }).getByRole('textbox', { name: /怎么改/ })).toBeVisible()
  await page.keyboard.press('Escape')
})
