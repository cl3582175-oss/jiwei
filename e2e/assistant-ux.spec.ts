import { attachmentModel, textOf } from './fixtures/attachment-model'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
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
