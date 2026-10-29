import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Effort } from '../src/shared/ai'
import { isolatedElectron } from './fixtures/isolateElectron'
import { navTo } from './fixtures/nav'

interface WireState {
  calls: { url: string; body: Record<string, unknown> }[]
  unexpected: string[]
  hold: boolean
  releases: (() => void)[]
  original: unknown
  restoreStorage?: () => void
}
let app: ElectronApplication, page: Page, providerId: string
const models = ['gpt-6.1-terra', 'gpt-6-astra', 'gpt-5', 'gpt-5-pro', 'gpt-4o', 'unconfirmed-model']
test.setTimeout(90000)

test.beforeEach(async () => {
  app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'jiwei-model-compat-'))],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_MEMORY_DELAY_MS: '3600000'
    }
  })
  await app.evaluate(({ net, safeStorage }) => {
    const state: WireState = { calls: [], unexpected: [], hold: false, releases: [], original: net.fetch }
    ;(globalThis as unknown as { modelCompatibility: WireState }).modelCompatibility = state
    // Headless Linux runners have no OS keyring. This test-only peer accepts only
    // the synthetic key below; production credential handling is never changed.
    if (!safeStorage.isEncryptionAvailable()) {
      const original = {
        isEncryptionAvailable: safeStorage.isEncryptionAvailable,
        encryptString: safeStorage.encryptString,
        decryptString: safeStorage.decryptString
      }
      const key = 'synthetic-test-key'
      const encoded = 'jiwei-model-test-only:' + key
      safeStorage.isEncryptionAvailable = () => true
      safeStorage.encryptString = (value) => {
        if (value !== key) throw new Error('Only the synthetic test key is allowed')
        return Buffer.from(encoded)
      }
      safeStorage.decryptString = (value) => {
        if (value.toString() !== encoded) throw new Error('Unexpected test credential')
        return key
      }
      state.restoreStorage = () => {
        Object.assign(safeStorage, original)
      }
    }
    net.fetch = async (input, init) => {
      const url = String(input)
      if (!['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/chat/completions'].includes(url)) {
        state.unexpected.push(url)
        throw new Error('Unexpected external request in isolated compatibility test')
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      state.calls.push({ url, body })
      const native = url.endsWith('/responses')
      const text = '这是一段用于快捷提问的公开回答。'
      const usage = { input_tokens: 20, output_tokens: 5, total_tokens: 25, output_tokens_details: { reasoning_tokens: 1 } }
      const message = { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
      const response = {
        id: 'resp_test',
        object: 'response',
        created_at: 1,
        model: body.model,
        status: 'completed',
        output: [message],
        usage
      }
      if (!body.stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      const encoder = new TextEncoder()
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: unknown): void => {
            controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'))
          }
          if (native) {
            emit({ type: 'response.created', response })
            emit({ type: 'response.output_item.added', output_index: 0, item: message })
            emit({ type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: text })
          } else {
            emit({
              id: 'chat_test',
              object: 'chat.completion.chunk',
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
            })
          }
          const finish = (): void => {
            if (cancelled) return
            if (native) {
              emit({ type: 'response.output_item.done', output_index: 0, item: message })
              emit({ type: 'response.completed', response })
            } else {
              emit({
                id: 'chat_test',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
              })
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            }
            controller.close()
          }
          if (state.hold) state.releases.push(finish)
          else finish()
        },
        cancel() {
          cancelled = true
        }
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 750))
  providerId = await page.evaluate(async (models) => {
    const p = await window.jiwei.providers.save({
      kind: 'openai',
      name: 'Compatibility controlled',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'synthetic-test-key',
      models,
      sendEffort: true
    })
    const s = await window.jiwei.settings.get()
    await window.jiwei.memory.setSettings({ autoLearn: false, learnSkills: false })
    await window.jiwei.settings.set({
      ai: {
        ...s.ai,
        chat: { providerId: p.id, model: 'gpt-6.1-terra' },
        effort: 'max',
        embedding: { mode: 'cloud', providerId: null, model: null }
      }
    })
    return p.id
  }, models)
  await page.reload()
  await page.waitForSelector('nav')
})
test.afterEach(async () => {
  if (!app) return
  try {
    const unexpected = await app.evaluate(({ net }) => {
      const state = (globalThis as unknown as { modelCompatibility: WireState }).modelCompatibility
      for (const release of state.releases.splice(0)) release()
      net.fetch = state.original as typeof net.fetch
      state.restoreStorage?.()
      return state.unexpected
    })
    expect(unexpected).toEqual([])
  } finally {
    await app.close()
  }
})
const group = (root: Page | Locator = page) => root.getByRole('radiogroup', { name: /思考强度|Thinking effort/ })
const effortButton = (root: Page | Locator = page) => root.getByRole('button', { name: /^(思考强度|Thinking effort)$/ })
async function expectCollapsedLevels(labels: string[], root: Page | Locator = page, checked?: string) {
  await expect(page.getByRole('menuitemradio')).toHaveCount(0)
  await effortButton(root).click()
  const items = page.getByRole('menuitemradio')
  await expect(items).toHaveCount(labels.length)
  for (let i = 0; i < labels.length; i++) await expect(items.nth(i)).toContainText(labels[i])
  if (checked) await expect(items.filter({ hasText: checked }).first()).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}
async function choose(model: string, root: Page | Locator = page) {
  await root.getByRole('button', { name: /^(模型|Model)$/ }).click()
  await page.getByRole('option', { name: model, exact: true }).click()
}
async function expandChatSidebar() {
  const sidebar = page.getByTestId('sidebar-chat')
  await expect(sidebar).toBeVisible()
  if ((await sidebar.getAttribute('data-collapsed')) === 'true') {
    await sidebar.getByTestId('sidebar-expand-pin').click()
  }
  await expect(sidebar).toHaveAttribute('data-collapsed', 'false')
}
async function hold(enabled: boolean) {
  await app.evaluate((_electron, enabled) => {
    const state = (globalThis as unknown as { modelCompatibility: WireState }).modelCompatibility
    state.hold = enabled
    if (!enabled) for (const release of state.releases.splice(0)) release()
  }, enabled)
}
async function wire() {
  return app.evaluate(() => (globalThis as unknown as { modelCompatibility: WireState }).modelCompatibility.calls)
}
async function lastAssistant(conversationId: string) {
  return (await page.evaluate((id) => window.jiwei.chat.messages(id), conversationId)).filter((m) => m.role === 'assistant').at(-1)!
}

test('all four effort pickers follow the model, including default states and narrow panels', async () => {
  await navTo(page, /积微助手/)
  await expectCollapsedLevels(['关闭', '低', '中', '高', '超高', '极限'], page, '高')
  await choose('gpt-6-astra')
  await expectCollapsedLevels(['低', '中', '高', '超高', '极限'])
  await choose('gpt-5')
  await expectCollapsedLevels(['最少', '低', '中', '高'])
  await choose('gpt-5-pro')
  await expectCollapsedLevels(['高'])
  await choose('unconfirmed-model')
  await expectCollapsedLevels([])
  await expect(effortButton()).toContainText('默认')
  await choose('gpt-4o')
  await expectCollapsedLevels([])
  await choose('gpt-6.1-terra')
  const project = await page.evaluate(() => window.jiwei.chatProjects.create({ name: '档位项目', libraryScope: 'none' }))
  await expandChatSidebar()
  await page
    .locator('[data-project-id="' + project.id + '"] [data-sidebar-row]')
    .first()
    .click()
  const home = page.getByTestId('project-home')
  await expectCollapsedLevels(['关闭', '低', '中', '高', '超高', '极限'], home)
  await choose('gpt-6-astra', home)
  await expectCollapsedLevels(['低', '中', '高', '超高', '极限'], home)
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手' })
  await expectCollapsedLevels(['关闭', '低', '中', '高', '超高', '极限'], panel)
  await choose('gpt-5', panel)
  await expectCollapsedLevels(['最少', '低', '中', '高'], panel)
  await page.keyboard.press('ControlOrMeta+j')
  await page.keyboard.press('ControlOrMeta+,')
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('tab', { name: 'AI 模型', exact: true }).click()
  await expect(group(dialog).getByRole('radio')).toHaveCount(6)
  await choose('gpt-6-astra', dialog)
  await expect(group(dialog).getByRole('radio')).toHaveCount(5)
  await choose('gpt-6.1-terra', dialog)
  await group(dialog).getByRole('radio', { name: '极限', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.settings.get())).ai.effort).toBe('openai-max')
  await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ language: 'en', ai: s.ai })
  })
  await page.reload()
  await page.waitForSelector('nav')
  await page.keyboard.press('ControlOrMeta+j')
  const english = page.getByRole('complementary')
  await expectCollapsedLevels(['Off', 'Low', 'Med', 'High', 'XHigh', 'Max'], english)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(700, 750))
  const overflows = await effortButton(english).evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  expect(overflows).toBe(false)
  await effortButton(english).click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(6)
  await page.screenshot({ path: test.info().outputPath('effort-menu-preserved.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
})

test('effective effort is returned, saved and shown while streaming, then survives reload', async () => {
  await hold(true)
  await navTo(page, /积微助手/)
  await page.getByRole('textbox').fill('公开档位验证第一轮')
  await page.getByRole('textbox').press('Enter')
  await expect.poll(async () => (await wire()).length).toBe(1)
  const conv = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  await expect.poll(async () => (await lastAssistant(conv.id)).effort).toBe('high')
  expect((await lastAssistant(conv.id)).status).toBe('streaming')
  await expect(page.locator('[data-message-id]').last()).toContainText('思考：高')
  await page.locator('[data-message-id]').last().hover()
  await expect(page.locator('[data-message-id]').last().getByText('· 思考：高', { exact: true })).toBeVisible()
  expect((await wire())[0].body.reasoning).toEqual({ effort: 'high' })
  // Changing provider configuration after construction must not change this in-flight snapshot.
  await page.evaluate(async (providerId) => {
    const p = (await window.jiwei.providers.list()).find((p) => p.id === providerId)!
    await window.jiwei.providers.save({ ...p, sendEffort: false })
  }, providerId)
  await hold(false)
  await expect.poll(async () => (await lastAssistant(conv.id)).status).toBe('done')
  expect((await lastAssistant(conv.id)).effort).toBe('high')
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /积微助手/)
  await expandChatSidebar()
  await page
    .locator('[data-conversation-id="' + conv.id + '"] [data-sidebar-row]')
    .first()
    .click()
  await expectCollapsedLevels([])
  await expect(effortButton()).toContainText('默认')
  await hold(true)
  await page.getByRole('textbox').fill('公开默认占位')
  await page.getByRole('textbox').press('Enter')
  await expect.poll(async () => (await wire()).length).toBe(2)
  await expect.poll(async () => (await lastAssistant(conv.id)).effort).toBeNull()
  expect((await lastAssistant(conv.id)).status).toBe('streaming')
  await expect(page.locator('[data-message-id]').last()).not.toContainText('思考：')
  await hold(false)
  await expect.poll(async () => (await lastAssistant(conv.id)).status).toBe('done')
  const disabled = await page.evaluate(
    ({ providerId, conversationId }) =>
      window.jiwei.chat.send({
        conversationId,
        providerId,
        model: 'gpt-6.1-terra',
        effort: 'openai-max',
        text: '公开默认档位',
        scope: { type: 'none' },
        web: 'off'
      }),
    { providerId, conversationId: conv.id }
  )
  expect(disabled.effort).toBeNull()
  await expect.poll(async () => (await lastAssistant(conv.id)).status).toBe('done')
  expect((await lastAssistant(conv.id)).effort).toBeNull()
  expect((await wire()).at(-1)!.body.reasoning ?? {}).not.toHaveProperty('effort')
  await page.evaluate(async (providerId) => {
    const p = (await window.jiwei.providers.list()).find((p) => p.id === providerId)!
    await window.jiwei.providers.save({ ...p, sendEffort: true })
  }, providerId)
  for (const effort of ['xhigh', 'openai-max'] as const) {
    const turn = await page.evaluate(
      ({ providerId, conversationId, effort }) =>
        window.jiwei.chat.send({
          conversationId,
          providerId,
          model: 'gpt-6.1-terra',
          effort,
          text: '公开新档位 ' + effort,
          scope: { type: 'none' },
          web: 'off'
        }),
      { providerId, conversationId: conv.id, effort }
    )
    expect(turn.effort).toBe(effort)
    await expect.poll(async () => (await lastAssistant(conv.id)).status).toBe('done')
    expect((await lastAssistant(conv.id)).effort).toBe(effort)
  }
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /积微助手/)
  await expandChatSidebar()
  await page
    .locator('[data-conversation-id="' + conv.id + '"] [data-sidebar-row]')
    .first()
    .click()
  await expectCollapsedLevels(['关闭', '低', '中', '高', '超高', '极限'], page, '极限')
  await expect(page.locator('[data-message-id]').last()).toContainText('思考：极限')
  expect((await wire()).map((c) => (c.body.reasoning as { effort?: string } | undefined)?.effort)).toEqual([
    'high',
    undefined,
    undefined,
    'xhigh',
    'max'
  ])
})

test('inline clarification keeps new preferences while explanation asks for the lowest valid level', async () => {
  const seed = await page.evaluate(
    (providerId) =>
      window.jiwei.chat.send({
        conversationId: null,
        providerId,
        model: 'gpt-6.1-terra',
        effort: 'high',
        text: '公开快捷操作验证',
        scope: { type: 'none' },
        web: 'off'
      }),
    providerId
  )
  await expect.poll(async () => (await lastAssistant(seed.conversation.id)).status).toBe('done')
  for (const [preference, action, wireEffort, saved] of [
    ['xhigh', '讲明白', 'xhigh', 'xhigh'],
    ['openai-max', '讲明白', 'max', 'openai-max'],
    ['openai-max', '解释', 'none', 'off']
  ] as const) {
    await page.evaluate(async (effort: Effort) => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...s.ai, effort } })
    }, preference)
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /积微助手/)
    await expandChatSidebar()
    await page
      .locator('[data-conversation-id="' + seed.conversation.id + '"] [data-sidebar-row]')
      .first()
      .click()
    const reply = page.locator('[data-reply-id="' + seed.assistantMessageId + '"]')
    await reply.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el.querySelector('p')!)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    const previous = (await wire()).length
    const previousThreads = (await page.evaluate((id) => window.jiwei.chat.threads(id), seed.assistantMessageId)).map((t) => t.id)
    await hold(true)
    await page.getByRole('toolbar').getByRole('button', { name: action, exact: true }).click()
    const card = page.getByRole('dialog', { name: '就地答复' })
    await expect(card).toBeVisible()
    await expect.poll(async () => (await wire()).length).toBe(previous + 1)
    expect((await wire()).at(-1)!.body.reasoning).toEqual({ effort: wireEffort })
    await expect(card.locator('.chat-md').last()).toContainText('这是一段用于快捷提问的公开回答。')
    await expect(card.locator('[data-slot="message-footer"]')).toHaveCount(0)
    await hold(false)
    const threads = await page.evaluate((id) => window.jiwei.chat.threads(id), seed.assistantMessageId)
    const thread = threads.find((t) => !previousThreads.includes(t.id))!
    await expect.poll(async () => (await lastAssistant(thread.id)).status).toBe('done')
    expect((await lastAssistant(thread.id)).effort).toBe(saved)
    await card.getByRole('button', { name: '关闭', exact: true }).click()
  }
})
