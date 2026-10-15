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
    await page.getByRole('textbox', { name: '我是', exact: true }).fill('档案窗口快捷键保存标记')
    await page.keyboard.press('Meta+w')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await open()
    await expect(page.getByRole('textbox', { name: '我是', exact: true })).toHaveValue('档案窗口快捷键保存标记')
    expect(await page.evaluate(() => window.jiwei.memory.profile())).toMatchObject({ role: '档案窗口快捷键保存标记' })
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

test('P4 project defaults, stable recent order, search, two memory modes and deletion use real IPC', async () => {
  const model = await attachmentModel()
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-projects-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    const data = await page.evaluate(async (baseUrl) => {
      const p = await window.jiwei.providers.save({
        kind: 'openai',
        name: 'Controlled projects',
        baseUrl,
        apiKey: 'test-key',
        models: ['controlled'],
        modelCaps: { controlled: { tools: true } }
      })
      const settings = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: p.id, model: 'controlled' }, effort: 'off' } })
      await window.jiwei.memory.setProfile({ role: 'GLOBAL_PROFILE_MARKER' })
      await window.jiwei.memory.save({ kind: 'fact', content: 'GLOBAL_MEMORY_MARKER' })
      const a = await window.jiwei.chatProjects.create({
        name: '项目 A',
        memory: 'project',
        libraryScope: 'none',
        instructions: '每次回答以【项目】开头。'
      })
      const b = await window.jiwei.chatProjects.create({ name: '项目 B', memory: 'project', libraryScope: 'none', instructions: '' })
      const d = await window.jiwei.chatProjects.create({ name: '默认项目', memory: 'default', libraryScope: 'all', instructions: '' })
      return { providerId: p.id, a, b, d }
    }, model.url)
    const send = async (projectId: string | null, text: string, conversationId: string | null = null) => {
      const turn = await page.evaluate(
        ({ providerId, projectId, text, conversationId }) =>
          window.jiwei.chat.send({ providerId, projectId, conversationId, model: 'controlled', text, web: 'off', effort: 'off' }),
        { providerId: data.providerId, projectId, text, conversationId }
      )
      await expect
        .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), turn.conversation.id)).at(-1)?.status)
        .toBe('done')
      return turn
    }
    const system = () =>
      model.requests
        .at(-1)!
        .messages.filter((m) => m.role === 'system')
        .map((m) => textOf(m.content))
        .join('')
    model.tool('memory_remember', { kind: 'fact', content: 'PROJECT_A_ONLY_MARKER', sensitive: false })
    const a = await send(data.a.id, '请记住本项目的一项事实')
    expect(a.conversation.scope).toEqual({ type: 'none' })
    expect(system()).toContain('<project name="项目 A">每次回答以【项目】开头。</project>')
    expect(system()).toContain('GLOBAL_PROFILE_MARKER')
    expect(system()).not.toContain('GLOBAL_MEMORY_MARKER')
    expect(await page.evaluate((id) => window.jiwei.memory.list({ projectId: id }), data.a.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'PROJECT_A_ONLY_MARKER', projectId: data.a.id })])
    )
    expect(await page.evaluate(() => window.jiwei.memory.list({}))).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'PROJECT_A_ONLY_MARKER' })])
    )
    await send(data.a.id, '新对话读取本项目记忆')
    expect(system()).toContain('PROJECT_A_ONLY_MARKER')
    await send(data.b.id, '项目 B 的独立对话')
    expect(system()).not.toContain('PROJECT_A_ONLY_MARKER')
    expect(system()).not.toContain('GLOBAL_MEMORY_MARKER')
    model.tool('memory_remember', { kind: 'fact', content: 'DEFAULT_PROJECT_GLOBAL_MARKER', sensitive: false })
    await send(data.d.id, '默认项目记忆')
    expect(system()).toContain('GLOBAL_MEMORY_MARKER')
    const ordinary = await send(null, 'PROJECT_SEARCH_MATCH 普通对话')
    expect(system()).toContain('DEFAULT_PROJECT_GLOBAL_MARKER')
    expect(system()).not.toContain('PROJECT_A_ONLY_MARKER')
    const before = (await page.evaluate(() => window.jiwei.chat.conversations())).map((c) => c.id)
    await page.evaluate(async ({ id, projectId }) => window.jiwei.chat.update(id, { title: '已重命名', pinned: true, projectId }), {
      id: ordinary.conversation.id,
      projectId: data.d.id
    })
    expect((await page.evaluate(() => window.jiwei.chat.conversations())).map((c) => c.id)).toEqual(before)
    expect(await page.evaluate(() => window.jiwei.chat.search('PROJECT_SEARCH_MATCH'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversationId: ordinary.conversation.id,
          projectId: data.d.id,
          projectName: '默认项目',
          messageId: ordinary.userMessage.id
        })
      ])
    )
    const inline = await page.evaluate(
      ({ providerId, a }) => {
        const anchor = {
          kind: 'text' as const,
          parentType: 'message' as const,
          parentId: a.assistantMessageId,
          ownerId: a.conversation.id,
          quote: '已根据'
        }
        return window.jiwei.chat.send({
          providerId,
          model: 'controlled',
          conversationId: null,
          text: '就地提问继承项目',
          kind: 'inline',
          anchor,
          context: { targets: [anchor] },
          scope: { type: 'none' },
          web: 'off',
          effort: 'off'
        })
      },
      { providerId: data.providerId, a }
    )
    expect(inline.conversation.projectId).toBe(data.a.id)
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), inline.conversation.id)).at(-1)?.status)
      .toBe('done')
    expect((await page.evaluate((id) => window.jiwei.chatProjects.conversations(id), data.a.id)).map((c) => c.id)).not.toContain(
      inline.conversation.id
    )
    await page.evaluate(({ id, projectId }) => window.jiwei.chat.update(id, { projectId }), { id: a.conversation.id, projectId: data.b.id })
    expect((await page.evaluate((id) => window.jiwei.chat.get(id), inline.conversation.id))?.projectId).toBe(data.b.id)
    model.tool('memory_remember', { kind: 'fact', content: 'PROJECT_B_ONLY_MARKER', sensitive: false })
    await send(null, '移入后学到的新事实', a.conversation.id)
    expect(system()).not.toContain('PROJECT_A_ONLY_MARKER')
    expect(
      (await page.evaluate((id) => window.jiwei.memory.list({ projectId: id }), data.a.id)).some(
        (m) => m.content === 'PROJECT_A_ONLY_MARKER'
      )
    ).toBe(true)
    await expect(page.evaluate((id) => window.jiwei.chatProjects.update(id, { memory: 'project' }), data.d.id)).rejects.toThrow()
    await expect(page.evaluate((id) => window.jiwei.chatProjects.update(id, { memory: 'default' }), data.a.id)).rejects.toThrow()
    await page.evaluate((id) => window.jiwei.chatProjects.update(id, { memory: 'default', promoteMemories: true }), data.a.id)
    expect((await page.evaluate(() => window.jiwei.memory.list({}))).some((m) => m.content === 'PROJECT_A_ONLY_MARKER')).toBe(true)
    await page.evaluate((id) => window.jiwei.chatProjects.remove(id, 'recent'), data.b.id)
    expect((await page.evaluate((id) => window.jiwei.chat.get(id), a.conversation.id))?.projectId).toBeNull()
    expect(await page.evaluate((id) => window.jiwei.memory.list({ projectId: id }), data.b.id)).toEqual([])
    await page.evaluate((id) => window.jiwei.chatProjects.remove(id, 'delete'), data.d.id)
    expect(await page.evaluate((id) => window.jiwei.chat.get(id), ordinary.conversation.id)).toBeNull()
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})

test('P4 sidebar manages projects, flushes settings on Esc, searches message content and groups memories', async () => {
  const model = await attachmentModel()
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-project-ui-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await navTo(page, /积微助手/)
    const sidebar = page.locator('aside').filter({ has: page.getByRole('button', { name: '搜索对话', exact: true }) })
    await sidebar.getByRole('button', { name: '新建项目', exact: true }).click()
    const settings = page.getByTestId('project-settings')
    await settings.getByRole('textbox', { name: '项目名称' }).fill('侧栏 UI 项目')
    await settings.getByRole('combobox', { name: '记忆', exact: true }).selectOption('project')
    await settings.getByRole('button', { name: '新建项目', exact: true }).click()
    await expect(settings).toHaveCount(0)
    const project = (await page.evaluate(() => window.jiwei.chatProjects.list())).find((p) => p.name === '侧栏 UI 项目')!
    const projectRow = sidebar.locator(`[data-project-id="${project.id}"]`)
    await projectRow.hover()
    await projectRow.getByRole('button', { name: '项目菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '项目设置', exact: true }).click()
    await settings.getByRole('textbox', { name: '说明', exact: true }).fill('PROJECT_INSTRUCTIONS_ESC_MARKER')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    expect((await page.evaluate((id) => window.jiwei.chatProjects.get(id), project.id))?.instructions).toBe(
      'PROJECT_INSTRUCTIONS_ESC_MARKER'
    )
    await projectRow.hover()
    await projectRow.getByRole('button', { name: '项目菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '项目设置', exact: true }).click()
    await expect(settings.getByRole('textbox', { name: '说明', exact: true })).toHaveValue('PROJECT_INSTRUCTIONS_ESC_MARKER')
    await settings.getByRole('textbox', { name: '说明', exact: true }).fill('PROJECT_INSTRUCTIONS_CMD_W_MARKER')
    await page.keyboard.press('Meta+w')
    await expect(settings).toHaveCount(0)
    expect((await page.evaluate((id) => window.jiwei.chatProjects.get(id), project.id))?.instructions).toBe(
      'PROJECT_INSTRUCTIONS_CMD_W_MARKER'
    )
    const turn = await page.evaluate(
      async ({ url, projectId }) => {
        const p = await window.jiwei.providers.save({
          kind: 'openai',
          name: 'Controlled UI projects',
          baseUrl: url,
          apiKey: 'test-key',
          models: ['controlled']
        })
        const settings = await window.jiwei.settings.get()
        await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: p.id, model: 'controlled' }, effort: 'off' } })
        await window.jiwei.memory.save({ projectId, kind: 'fact', content: 'PROJECT_GROUP_MEMORY_MARKER' })
        return window.jiwei.chat.send({
          conversationId: null,
          providerId: p.id,
          model: 'controlled',
          text: 'MESSAGE_SEARCH_UI_MARKER',
          scope: { type: 'none' },
          web: 'off',
          effort: 'off'
        })
      },
      { url: model.url, projectId: project.id }
    )
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), turn.conversation.id)).at(-1)?.status)
      .toBe('done')
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /积微助手/)
    const row = sidebar.locator(`[data-conversation-id="${turn.conversation.id}"]`).first()
    await row.hover()
    await row.getByRole('button', { name: '对话菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
    const name = row.getByRole('textbox', { name: '重命名对话', exact: true })
    await name.fill('重命名后的侧栏对话')
    await name.press('Enter')
    await expect(name).toHaveCount(0)
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.chat.get(id), turn.conversation.id))?.title)
      .toBe('重命名后的侧栏对话')
    await row.hover()
    await row.getByRole('button', { name: '对话菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.chat.get(id), turn.conversation.id))?.pinned).toBe(true)
    await row.hover()
    await row.getByRole('button', { name: '对话菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '移到项目' }).hover()
    await page.getByRole('menuitem', { name: '侧栏 UI 项目', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.chat.get(id), turn.conversation.id))?.projectId)
      .toBe(project.id)
    await sidebar.getByRole('button', { name: '搜索对话', exact: true }).click()
    const search = page.getByRole('combobox', { name: '搜索对话', exact: true })
    await search.fill('MESSAGE_SEARCH_UI_MARKER')
    await expect(page.getByRole('option').filter({ hasText: '重命名后的侧栏对话' })).toBeVisible()
    await search.press('Enter')
    await expect(search).toHaveCount(0)
    await expect(page.locator(`[data-message-id="${turn.userMessage.id}"]`)).toBeInViewport()
    await page.keyboard.press('Meta+,')
    await page.getByRole('dialog').getByRole('button', { name: '关于我', exact: true }).click()
    await page.getByRole('tab', { name: '记忆', exact: true }).click()
    const group = page.locator(`[data-project-memory="${project.id}"]`)
    await group.getByRole('button', { name: /侧栏 UI 项目/ }).click()
    await expect(group).toContainText('PROJECT_GROUP_MEMORY_MARKER')
    await group.hover()
    await group.getByRole('button', { name: '钉住（总是参考）', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.jiwei.memory.list({ projectId: id }), project.id)).find(
            (m) => m.content === 'PROJECT_GROUP_MEMORY_MARKER'
          )?.pinned
      )
      .toBe(true)
    expect((await page.evaluate(() => window.jiwei.memory.list({}))).some((m) => m.content === 'PROJECT_GROUP_MEMORY_MARKER')).toBe(false)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})
