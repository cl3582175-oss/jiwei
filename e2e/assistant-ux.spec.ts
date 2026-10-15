import { navTo } from './fixtures/nav'
import { attachmentModel, textOf } from './fixtures/attachment-model'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('P1 profile survives immediate Esc, close button and tab switch', async () => {
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-assistant-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    const open = async () => {
      await page.keyboard.press('Meta+,')
      await page.getByRole('dialog').getByRole('button', { name: '关于我', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '我是', exact: true })).toBeVisible()
    }
    await open()
    await page.getByRole('textbox', { name: '我是', exact: true }).fill('档案 Esc 保存标记')
    await page.keyboard.press('Escape')
    await open()
    await expect(page.getByRole('textbox', { name: '我是', exact: true })).toHaveValue('档案 Esc 保存标记')
    await page.getByRole('textbox', { name: '我是', exact: true }).fill('档案按钮保存标记')
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    await open()
    await expect(page.getByRole('textbox', { name: '我是', exact: true })).toHaveValue('档案按钮保存标记')
    await page.getByRole('textbox', { name: '我是', exact: true }).fill('档案标签保存标记')
    await page.getByRole('dialog').getByRole('button', { name: '通用', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '关于我', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '我是', exact: true })).toHaveValue('档案标签保存标记')
    expect(await page.evaluate(() => window.jiwei.memory.profile())).toMatchObject({ role: '档案标签保存标记' })
  } finally {
    await app.close()
  }
})

test('P1 profile edits invalidate the ongoing conversation card', async () => {
  const model = await attachmentModel()
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-assistant-card-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    const provider = await page.evaluate(async (baseUrl) => {
      const p = await window.jiwei.providers.save({
        kind: 'openai',
        name: 'Controlled',
        baseUrl,
        apiKey: 'test-key',
        models: ['controlled']
      })
      await window.jiwei.memory.setProfile({ role: 'PROFILE_OLD_MARKER' })
      return p.id
    }, model.url)
    const send = async (conversationId: string | null) => {
      const turn = await page.evaluate(
        ({ providerId, conversationId }) =>
          window.jiwei.chat.send({
            providerId,
            model: 'controlled',
            conversationId,
            text: '你好',
            scope: { type: 'none' },
            web: 'off',
            effort: 'off'
          }),
        { providerId: provider, conversationId }
      )
      await expect
        .poll(
          async () =>
            (await page.evaluate((id) => window.jiwei.chat.messages(id), turn.conversation.id)).find(
              (m) => m.id === turn.assistantMessageId
            )?.status
        )
        .toBe('done')
      return turn.conversation.id
    }
    const id = await send(null)
    expect(
      model.requests
        .at(-1)!
        .messages.filter((m) => m.role === 'system')
        .map((m) => textOf(m.content))
        .join('')
    ).toContain('PROFILE_OLD_MARKER')
    await page.evaluate(() => window.jiwei.memory.setProfile({ role: 'PROFILE_NEW_MARKER' }))
    await send(id)
    const system = model.requests
      .at(-1)!
      .messages.filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .join('')
    expect(system).toContain('PROFILE_NEW_MARKER')
    expect(system).not.toContain('PROFILE_OLD_MARKER')
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})

test('P2 panel follows its page and restores the conversation and draft', async () => {
  const model = await attachmentModel({ chunkDelayMs: 200 })
  const answer = '离开页面后仍继续生成的完整回复。'.repeat(10)
  model.setAnswer(answer)
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-assistant-panel-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await page.evaluate(async (baseUrl) => {
      const p = await window.jiwei.providers.save({
        kind: 'openai',
        name: 'Controlled',
        baseUrl,
        apiKey: 'test-key',
        models: ['controlled']
      })
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...s.ai, chat: { providerId: p.id, model: 'controlled' }, effort: 'off' } })
    }, model.url)
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /笔记/)
    await page.keyboard.press('Meta+j')
    const panel = page.getByRole('complementary', { name: '积微助手' })
    await expect(panel).toBeVisible()
    const input = panel.getByRole('textbox').last()
    await input.fill('笔记页的面板对话')
    await input.press('Enter')
    await expect(panel.getByText('笔记页的面板对话', { exact: true })).toBeVisible()
    const conversationId = (await page.evaluate(() => window.jiwei.chat.conversations()))[0].id
    expect((await page.evaluate((id) => window.jiwei.chat.messages(id), conversationId)).at(-1)?.status).toBe('streaming')
    await input.fill('保留笔记页草稿')
    await navTo(page, /今日/)
    await expect(panel).toHaveCount(0)
    await page.keyboard.press('Meta+j')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('笔记页的面板对话', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Meta+j')
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), conversationId)).at(-1)?.status).toBe('done')
    await navTo(page, /笔记/)
    await expect(panel).toBeVisible()
    await expect(panel.getByText(answer, { exact: true })).toBeVisible()
    await expect(panel.getByText('笔记页的面板对话', { exact: true })).toBeVisible()
    await expect(panel.getByRole('textbox').last()).toHaveValue('保留笔记页草稿')
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})

test('P3 reply selection quotes, opens an inline card, restores its marker and cascades deletion', async () => {
  const model = await attachmentModel()
  model.setAnswer('这是用来解释选区的助手回复，其中包含需要进一步理解的概念。')
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-assistant-reply-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    const turn = await page.evaluate(async (baseUrl) => {
      const p = await window.jiwei.providers.save({
        kind: 'openai',
        name: 'Controlled',
        baseUrl,
        apiKey: 'test-key',
        models: ['controlled']
      })
      const settings = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: p.id, model: 'controlled' }, effort: 'off' } })
      return window.jiwei.chat.send({
        providerId: p.id,
        model: 'controlled',
        conversationId: null,
        text: '解释这个概念',
        scope: { type: 'none' },
        web: 'off',
        effort: 'off'
      })
    }, model.url)
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), turn.conversation.id)).at(-1)?.status)
      .toBe('done')
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /积微助手/)
    await page.getByText('解释这个概念', { exact: true }).first().click()
    const body = page.locator(`[data-reply-id="${turn.assistantMessageId}"]`)
    await expect(body).toBeVisible()
    const select = async () => {
      await body.evaluate((el) => {
        const text = el.querySelector('p')!.firstChild!
        const range = document.createRange()
        range.setStart(text, 0)
        range.setEnd(text, 12)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
    }
    await select()

    const toolbar = page.getByRole('toolbar')
    await expect(toolbar.getByRole('button', { name: '引用追问' })).toBeVisible()
    await expect(toolbar.getByRole('button', { name: '高亮' })).toHaveCount(0)
    await toolbar.getByRole('button', { name: '引用追问' }).click()
    await expect(page.getByTestId('reply-quote')).toContainText('这是用来解释选区的助手回')
    await select()
    await toolbar.getByRole('button', { name: '解释', exact: true }).click()
    const card = page.getByRole('dialog', { name: '就地答复' })
    await expect(card).toBeVisible()
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.chat.threads(id), turn.assistantMessageId)).length).toBe(1)
    await expect(page.getByRole('button', { name: '1 处就地提问' })).toBeVisible()
    expect(model.requests.map((r) => r.messages.map((m) => textOf(m.content)).join('')).join('')).toContain('<previous-answer>')
    await card.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '1 处就地提问' }).click()
    await page.getByRole('button').filter({ hasText: '这是用来解释选区的助手回' }).last().click()
    await expect(card).toBeVisible()
    await page.evaluate((id) => window.jiwei.chat.remove(id), turn.conversation.id)
    expect(await page.evaluate((id) => window.jiwei.chat.threads(id), turn.assistantMessageId)).toEqual([])
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})

test('P3 reply children inherit incognito and attachment memory restrictions', async () => {
  const model = await attachmentModel()
  const root = mkdtempSync(join(tmpdir(), 'jiwei-reply-private-'))
  const file = join(root, 'private.txt')
  writeFileSync(file, 'PRIVATE_PARENT_ATTACHMENT_MARKER')
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${join(root, 'profile')}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    const providerId = await page.evaluate(
      async (baseUrl) =>
        (await window.jiwei.providers.save({ kind: 'openai', name: 'Controlled', baseUrl, apiKey: 'test-key', models: ['controlled'] })).id,
      model.url
    )
    for (const incognito of [true, false]) {
      const parent = await page.evaluate(
        async ({ providerId, incognito, file }) => {
          const attachments = incognito ? [] : (await window.jiwei.attachments.add({ paths: [file] })).map((a) => a.sourceId)
          return window.jiwei.chat.send({
            providerId,
            model: 'controlled',
            conversationId: null,
            text: '父对话',
            incognito,
            attachments,
            scope: { type: 'none' },
            web: 'off',
            effort: 'off'
          })
        },
        { providerId, incognito, file }
      )
      await expect
        .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), parent.conversation.id)).at(-1)?.status)
        .toBe('done')
      const child = await page.evaluate(
        async ({ providerId, parent }) => {
          const anchor = {
            kind: 'text' as const,
            parentType: 'message' as const,
            parentId: parent.assistantMessageId,
            ownerId: parent.conversation.id,
            quote: '已根据'
          }
          return window.jiwei.chat.send({
            providerId,
            model: 'controlled',
            conversationId: null,
            text: '解释回复',
            kind: 'inline',
            anchor,
            context: { targets: [anchor] },
            scope: { type: 'none' },
            web: 'off',
            effort: 'off'
          })
        },
        { providerId, parent }
      )
      expect(child.conversation.incognito).toBe(incognito)
      await expect
        .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), child.conversation.id)).at(-1)?.status)
        .toBe('done')
      const request = model.requests.at(-1)!
      expect(request.tools?.map((t) => t.function.name)).not.toContain('memory_remember')
      expect(request.messages.map((m) => textOf(m.content)).join('')).not.toContain('PRIVATE_PARENT_ATTACHMENT_MARKER')
    }
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})
