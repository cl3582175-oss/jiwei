import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'
import { attachmentModel } from './fixtures/attachment-model'
import { navTo } from './fixtures/nav'

// The service is a test-only protocol peer. Renderer, IPC, chat service and storage are real.
let app: ElectronApplication, page: Page, model: Awaited<ReturnType<typeof attachmentModel>>
const reasoning = '先核对已有材料，再给出有依据的回答。'
const answer = '新的消息界面仍通过真实会话路径逐步显示回答。'
const shots = process.env.JIWEI_AI_ELEMENTS_SHOTS_DIR

test.beforeEach(async () => {
  model = await attachmentModel({ chunkDelayMs: 35, reasoning })
  model.setAnswer(answer)
  app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-ai-elements-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async (baseUrl) => {
    const p = await window.jiwei.providers.save({
      kind: 'custom',
      name: 'E2E protocol',
      baseUrl,
      apiKey: 'test-key',
      models: ['controlled', 'controlled-secondary']
    })
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: p.id, model: 'controlled' }, effort: 'off' } })
  }, model.url)
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /AI 对话/)
  await page.getByRole('button', { name: '检索范围' }).click()
  await page.getByRole('menuitem', { name: '不使用知识库' }).click()
})

test.afterEach(async () => {
  await app?.close()
  await new Promise<void>((resolve) => model?.server.close(() => resolve()))
})

async function send(text: string): Promise<void> {
  const input = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  const messages = page.locator('main [data-message-id]')
  const previousCount = await messages.count()
  await input.fill(text)
  await input.press('Enter')
  await expect(messages).toHaveCount(previousCount + 2)
  await expect(page.locator('.chat-md').last()).toContainText(answer)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
}

test('user bubbles and assistant responses follow the shared message composition with a working copy action', async () => {
  const question = '核对人和 AI 的消息呈现。'.repeat(28)
  await send(question)
  const user = page.locator('main [data-slot="message"][data-align="end"]').last()
  const userBubble = user.locator('[data-slot="bubble"]')
  await expect(userBubble).toHaveAttribute('data-variant', 'muted')
  await expect(userBubble).toHaveText(question)
  const userBox = await user.boundingBox()
  const bubbleBox = await userBubble.boundingBox()
  expect(userBox).not.toBeNull()
  expect(bubbleBox).not.toBeNull()
  expect(bubbleBox!.width).toBeLessThanOrEqual(userBox!.width * 0.8 + 1)
  expect(Math.abs(bubbleBox!.x + bubbleBox!.width - userBox!.x - userBox!.width)).toBeLessThan(2)
  const assistant = page.locator('main [data-slot="message"][data-align="start"]').last()
  const response = assistant.locator('[data-slot="bubble"][data-variant="ghost"]')
  await expect(response.locator('.chat-md')).toContainText(answer)
  const surface = await response.locator('[data-slot="bubble-content"]').evaluate((el) => {
    const style = getComputedStyle(el)
    return { background: style.backgroundColor, padding: style.padding, overflow: style.overflow }
  })
  expect(surface.background).toBe('rgba(0, 0, 0, 0)')
  expect(surface.padding).toBe('0px')
  expect(surface.overflow).toBe('visible')
  const assistantBox = await assistant.boundingBox()
  const responseBox = await response.boundingBox()
  expect(Math.abs(assistantBox!.width - responseBox!.width)).toBeLessThan(2)
  const footer = assistant.locator('[data-slot="message-footer"]')
  expect(await footer.locator('[data-slot="bubble"]').count()).toBe(0)
  await footer.getByRole('button', { name: '复制', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answer)
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  const saved = await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)
  expect(saved[0]).toMatchObject({ role: 'user', content: question })
  expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: answer, status: 'done' })
  if (shots) await page.screenshot({ path: join(shots, 'messages.png'), animations: 'disabled' })
})

test('reasoning is keyboard accessible and messages survive reopening', async () => {
  await send('检查思考过程和持久化')
  const trigger = page.getByRole('button', { name: /^思考过程/ }).first()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText(reasoning, { exact: true })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, 'reasoning.png'), animations: 'disabled' })
  await page.keyboard.press('Space')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText(reasoning, { exact: true })).toBeHidden()
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  expect((await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)).toMatchObject({
    content: answer,
    reasoning,
    status: 'done'
  })
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /AI 对话/)
  await page.getByText(conversation.title, { exact: true }).first().click()
  await expect(page.locator('.chat-md').last()).toContainText(answer)
})

test('IME and multiline input do not send; stopping preserves partial output and permits the next turn', async () => {
  const input = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  await input.fill('第一行')
  await input.press('Shift+Enter')
  await page.keyboard.insertText('你')
  await expect(input).toHaveValue('第一行\n你')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })
  expect(await page.evaluate(() => window.jiwei.chat.conversations())).toHaveLength(0)
  model.setAnswer(answer.repeat(100))
  await input.press('Enter')
  await expect(page.locator('.chat-md').last()).toContainText(answer)
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  const messages = await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)
  expect(messages.at(-1)?.status).toBe('stopped')
  expect(messages.at(-1)?.content.length).toBeGreaterThan(0)
  model.setAnswer(answer)
  await send('停止后继续提问')
  const next = await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)
  expect(next.filter((message) => message.role === 'user')).toHaveLength(2)
  expect(next.at(-1)?.status).toBe('done')
})

test('the workspace assistant retains its sending path in a narrow panel', async () => {
  await navTo(page, /笔记/)
  await page.keyboard.press('Meta+j')
  const panel = page.getByRole('complementary', { name: '积微助手' })
  await expect(panel).toBeVisible()
  const input = panel.getByRole('textbox').last()
  const composer = panel.locator('[data-slot="input-group"]').filter({ has: page.locator('textarea') })
  await expect(composer.getByRole('button', { name: '模型', exact: true })).toBeVisible()
  await expect(composer.getByRole('button', { name: '思考强度', exact: true })).toBeVisible()
  await input.fill('侧栏消息路径')
  await input.press('Enter')
  await expect(panel.locator('.chat-md').last()).toContainText(answer)
  await expect(panel.locator('[data-slot="bubble"][data-variant="muted"]').last()).toHaveText('侧栏消息路径')
  const response = panel.locator('[data-slot="bubble"][data-variant="ghost"]').last()
  await expect(response.locator('.chat-md')).toContainText(answer)
  const copy = panel.locator('[data-slot="message-footer"]').getByRole('button', { name: '复制', exact: true }).last()
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answer)
  const trigger = panel.getByRole('button', { name: /^思考过程/ }).first()
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(panel.getByText(reasoning, { exact: true })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, 'assistant.png'), animations: 'disabled' })
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})

test('model selector searches configured models and the next answer uses the selected model', async () => {
  const composer = page.locator('[data-slot="input-group"]').filter({ has: page.getByRole('textbox', { name: '问积微，或交代一件事……' }) })
  const trigger = composer.getByRole('button', { name: '模型', exact: true })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const search = page.getByRole('combobox', { name: '搜索模型' })
  await expect(search).toBeFocused()
  await search.fill('secondary')
  const popup = page.locator('[data-slot="model-selector-content"]')
  await expect(popup).toBeVisible()
  await expect
    .poll(async () => {
      const bounds = await popup.boundingBox()
      const anchor = await trigger.boundingBox()
      if (!bounds || !anchor) return Infinity
      return Math.min(Math.abs(bounds.y + bounds.height - anchor.y), Math.abs(bounds.y - anchor.y - anchor.height))
    })
    .toBeLessThan(16)
  if (shots) await page.screenshot({ path: join(shots, 'model-selector.png'), animations: 'disabled' })
  await expect(page.getByRole('option', { name: 'controlled', exact: true })).toHaveCount(0)
  await page.getByRole('option', { name: 'controlled-secondary', exact: true }).click()
  await expect(page.getByRole('button', { name: '模型', exact: true })).toContainText('controlled-secondary')
  await send('验证选定模型的真实会话')
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  expect((await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)?.model).toBe('controlled-secondary')
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(popup).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('thinking effort stays collapsed inside the composer and its menu changes the real request and saved conversation', async () => {
  const composer = page.locator('[data-slot="input-group"]').filter({ has: page.getByRole('textbox', { name: '问积微，或交代一件事……' }) })
  const trigger = composer.getByRole('button', { name: '思考强度', exact: true })
  await expect(trigger).toContainText('关闭')
  await expect(composer.getByRole('radio')).toHaveCount(0)
  await expect(page.getByRole('menuitemradio')).toHaveCount(0)
  await trigger.click()
  const high = page.getByRole('menuitemradio', { name: /^高/ })
  await expect(page.getByRole('menuitemradio', { name: /^关闭/ })).toHaveAttribute('aria-checked', 'true')
  if (shots) await page.screenshot({ path: join(shots, 'effort-menu.png'), animations: 'disabled' })
  await high.click()
  await expect(trigger).toContainText('高')
  await expect(page.getByRole('menuitemradio')).toHaveCount(0)
  await send('验证思考强度的真实请求')
  expect(model.requests.at(-1)).toMatchObject({ reasoning_effort: 'high' })
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  expect((await page.evaluate(() => window.jiwei.settings.get())).ai.effort).toBe('off')
  expect((await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)?.effort).toBe('high')
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /AI 对话/)
  await page.getByText(conversation.title, { exact: true }).first().click()
  await expect(trigger).toContainText('高')
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('a plan keeps a distinct current step while its details can be expanded with the keyboard', async () => {
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, localModels: 'normal' } } })
  })
  model.setAnswer(
    '```jiwei-ui\n' +
      JSON.stringify({
        type: 'steps',
        title: '计划进度检查',
        current: 1,
        items: [
          { title: '准备完毕', detail: '准备工作的真实说明。' },
          { title: '正在进行', detail: '当前步骤的真实说明。' },
          { title: '下一步' }
        ]
      }) +
      '\n```'
  )
  const input = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  await input.fill('显示具有进度的计划')
  await input.press('Enter')
  const plan = page.locator('[data-ui-type="steps"]')
  const current = plan.locator('[aria-current="step"]')
  await expect(current.locator('.ui-step-dot')).toBeVisible()
  const currentColor = await current.locator('.ui-step-dot').evaluate((el) => getComputedStyle(el).backgroundColor)
  const futureColor = await plan
    .locator('.ui-step')
    .last()
    .locator('.ui-step-dot')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(currentColor).not.toBe(futureColor)
  const toggle = current.getByRole('button', { name: '正在进行', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(current.getByText('当前步骤的真实说明。')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, 'plan.png'), animations: 'disabled' })
})

test('saved note checkpoints preview and restore the real document', async () => {
  const note = await page.evaluate(() => window.jiwei.notes.create({ title: '检查点恢复验收' }))
  await navTo(page, /笔记/)
  await page.getByText('检查点恢复验收', { exact: true }).first().click()
  const body = page.locator('.cornell-body p').first()
  await body.fill('检查点中的原始正文')
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.notes.blocks(id), note.id)).some((b) => b.text === '检查点中的原始正文'))
    .toBe(true)
  await page.locator('main header').getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '保存当前版本', exact: true }).click()
  await body.fill('之后修改的正文')
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.notes.blocks(id), note.id)).some((b) => b.text === '之后修改的正文'))
    .toBe(true)
  await page.getByRole('button', { name: '版本历史', exact: true }).click()
  const history = page.getByRole('dialog')
  await history.getByRole('button').filter({ hasText: '手动保存' }).first().click()
  await expect(history.locator('.cornell-body')).toContainText('检查点中的原始正文')
  if (shots) await page.screenshot({ path: join(shots, 'checkpoint.png'), animations: 'disabled' })
  await history.getByRole('button', { name: '恢复此版本', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '恢复此版本', exact: true }).click()
  await expect(body).toHaveText('检查点中的原始正文')
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.notes.blocks(id), note.id)).some((b) => b.text === '检查点中的原始正文'))
    .toBe(true)
})

test('all existing palettes and light/dark themes keep messages and controls readable without overflow', async () => {
  model.setAnswer(`${answer}\n\n${'很长的连续文本'.repeat(80)}`)
  const input = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  await input.fill('检查全部主题')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.chat-md').last()).toContainText(answer)
  for (const palette of ['qinglu', 'celadon', 'dunhuang'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => window.jiwei.settings.set(value), { palette, theme })
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
      const body = page.locator('.chat-md').last()
      expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      const colors = await input.evaluate((el) => {
        const style = getComputedStyle(el)
        return { text: style.color, opacity: style.opacity, height: el.getBoundingClientRect().height }
      })
      expect(colors.text).not.toBe('rgba(0, 0, 0, 0)')
      expect(Number(colors.opacity)).toBe(1)
      expect(colors.height).toBeGreaterThan(20)
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
      if (shots) await page.screenshot({ path: join(shots, `${palette}-${theme}.png`), animations: 'disabled' })
    }
  }
})
