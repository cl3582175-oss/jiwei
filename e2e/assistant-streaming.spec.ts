import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'
import { attachmentModel } from './fixtures/attachment-model'
import { navTo } from './fixtures/nav'

// Only the model transport is a local protocol peer. All UI, IPC and storage are real.
let app: ElectronApplication
let page: Page
let model: Awaited<ReturnType<typeof attachmentModel>>
const response =
  '首段逐字晕开，前文应该保持清晰。\n\n**新增内容**和 `ready` 随流到达。\n\n' + '继续输出新的文字，已经显示的内容不要重播。'.repeat(14)

interface BlurEvent {
  text: string
  duration: number
  delay: number
  frames: { filter?: string; opacity?: string | number }[]
}

async function observeBlur(): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & { replyBlurEvents: BlurEvent[] }
    state.replyBlurEvents = []
    document.addEventListener(
      'animationstart',
      (event) => {
        if (!(event instanceof AnimationEvent) || event.animationName !== 'sd-blurIn') return
        const node = event.target
        if (!(node instanceof HTMLElement) || !node.closest('.chat-md')) return
        const style = getComputedStyle(node)
        if (Number.parseFloat(style.animationDuration) === 0) return
        const animation = node.getAnimations().find((animation) => (animation as CSSAnimation).animationName === event.animationName)
        state.replyBlurEvents.push({
          text: node.textContent ?? '',
          duration: Number.parseFloat(style.animationDuration),
          delay: Number.parseFloat(style.animationDelay),
          frames:
            animation?.effect instanceof KeyframeEffect
              ? animation.effect.getKeyframes().map(({ filter, opacity }) => ({ filter, opacity }))
              : []
        })
      },
      true
    )
  })
}

async function launch(delay = 80, chunkSize = 12): Promise<void> {
  model = await attachmentModel({ chunkDelayMs: delay, chunkSize })
  model.setAnswer(response)
  app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-reply-blur-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async (baseUrl) => {
    const provider = await window.jiwei.providers.save({
      kind: 'custom',
      name: 'Local streaming peer',
      baseUrl,
      apiKey: 'test-key',
      models: ['controlled']
    })
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: provider.id, model: 'controlled' }, effort: 'off' } })
  }, model.url)
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /积微助手/)
  await page.getByRole('button', { name: '检索范围', exact: true }).click()
  await page.getByRole('menuitem', { name: '不使用知识库', exact: true }).click()
  await observeBlur()
}

test.afterEach(async () => {
  await app?.close()
  model?.server.closeAllConnections()
  if (model) await new Promise<void>((resolve) => model.server.close(() => resolve()))
})

async function send(input: Locator, question = '检查流式回复的逐字晕开'): Promise<void> {
  await input.fill(question)
  await input.press('Enter')
}

async function expectCharacterBlur(body: Locator): Promise<void> {
  await expect(body).toContainText('首段逐字晕开')
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { replyBlurEvents: BlurEvent[] }).replyBlurEvents.length))
    .toBeGreaterThan(1)
  const events = await page.evaluate(() => (window as typeof window & { replyBlurEvents: BlurEvent[] }).replyBlurEvents)
  expect(events.every((event) => [...event.text.trim()].length === 1)).toBe(true)
  expect(events.some((event) => event.frames[0]?.filter === 'blur(4px)' && event.frames.at(-1)?.filter === 'blur(0px)')).toBe(true)
  expect(new Set(events.map((event) => event.delay)).size).toBeGreaterThan(1)
  expect(events.every((event) => event.duration > 0 && event.duration < 1)).toBe(true)
}

test('new text blurs character by character without replaying the readable prefix, and stop keeps the real partial answer', async () => {
  await launch()
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }))
  const body = page.locator('main .chat-md').last()
  await expectCharacterBlur(body)
  const first = await body.locator('[data-sd-animate]').first().elementHandle()
  expect(first).not.toBeNull()
  await expect.poll(() => first!.evaluate((node) => getComputedStyle(node).filter)).toBe('blur(0px)')
  const length = (await body.textContent())!.length
  await expect.poll(async () => (await body.textContent())!.length).toBeGreaterThan(length + 24)
  expect(await first!.evaluate((node) => node.isConnected)).toBe(true)
  expect(await first!.evaluate((node) => getComputedStyle(node).filter)).toBe('blur(0px)')
  expect(await first!.evaluate((node) => node.getAnimations().some((animation) => animation.playState === 'running'))).toBe(false)
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByText('已停止生成', { exact: true })).toBeVisible()
  await expect(body.locator('[data-sd-animate]')).toHaveCount(0)
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  const saved = (await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)!
  expect(saved.status).toBe('stopped')
  expect(saved.content.length).toBeGreaterThan(0)
  expect(response.startsWith(saved.content)).toBe(true)
  await page.locator('main [data-slot="message-footer"]').getByRole('button', { name: '复制', exact: true }).last().click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(saved.content)
  model.setAnswer('停止后仍能继续回答。')
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }), '继续提问')
  await expect(page.locator('main .chat-md').last()).toContainText('停止后仍能继续回答。')
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
})

test('project conversations use the same live character blur and keep project ownership', async () => {
  await launch()
  const project = await page.evaluate(() => window.jiwei.chatProjects.create({ name: '动效项目', memory: 'project', libraryScope: 'none' }))
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /积微助手/)
  await page.locator(`[data-project-id="${project.id}"]`).getByText('动效项目', { exact: true }).click()
  await expect(page.getByTestId('project-home')).toBeVisible()
  await observeBlur()
  await send(page.getByRole('textbox', { name: '在“动效项目”中新对话', exact: true }))
  await expectCharacterBlur(page.locator('main .chat-md').last())
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  const conversations = await page.evaluate((id) => window.jiwei.chatProjects.conversations(id), project.id)
  expect(conversations).toHaveLength(1)
  expect((await page.evaluate((id) => window.jiwei.chat.messages(id), conversations[0].id)).at(-1)).toMatchObject({
    content: response,
    status: 'done'
  })
})

test('the narrow workspace assistant animates its actual streaming reply', async () => {
  await launch()
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手', exact: true })
  await send(panel.getByRole('textbox').last())
  await expectCharacterBlur(panel.locator('.chat-md').last())
  await expect(panel.locator('.chat-md').last()).toContainText('已经显示的内容不要重播')
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
})

test('in-place note answers use the same streaming blur without changing the note', async () => {
  await launch()
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('流式问答原笔记')
  await page.keyboard.press('Enter')
  await page.keyboard.type('需要解释的正文，回复动效不能修改它。')
  const body = page.locator('.cornell-body p').first()
  await body.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'AI 修改', exact: true }).click()
  await page.getByRole('menuitem', { name: '解释', exact: true }).click()
  const card = page.getByRole('dialog', { name: '就地答复', exact: true })
  await expectCharacterBlur(card.locator('.chat-md').last())
  await expect(body).toHaveText('需要解释的正文，回复动效不能修改它。')
})

test('reflection coach plain replies also blur character by character', async () => {
  await launch()
  await navTo(page, /复盘/)
  await page.getByTestId('weekly-card').getByRole('button', { name: '开始本周复盘', exact: true }).click()
  await page.getByRole('tab', { name: 'AI 追问', exact: true }).click()
  await page.getByRole('button', { name: '开始追问', exact: true }).click()
  await expectCharacterBlur(page.locator('.chat-md').last())
})

test('Feynman practice replies use the shared character blur through the real practice entry', async () => {
  await launch()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('机会成本')
  await page.getByRole('option', { name: /费曼练习：把「机会成本」讲给 AI 听/ }).click()
  await expect(page.getByRole('heading', { name: '把「机会成本」讲给小微听', exact: true })).toBeVisible()
  await send(page.getByPlaceholder('用你自己的话讲……（Enter 发送）'), '机会成本是做出选择时放弃的最好替代方案的价值。')
  await expectCharacterBlur(page.locator('.chat-md').last())
})

test('a single-chunk reply finishes its blur, copies and persists exactly, and history does not replay', async () => {
  await launch(0)
  const short = '短回复也逐字晕开。'
  model.setAnswer(short)
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }))
  const body = page.locator('main .chat-md').last()
  await expect(body).toHaveText(short)
  await expect
    .poll(() => page.evaluate(() => (window as typeof window & { replyBlurEvents: BlurEvent[] }).replyBlurEvents.length))
    .toBeGreaterThan(1)
  await expect(body.locator('[data-sd-animate]')).toHaveCount(0)
  await page.locator('main [data-slot="message-footer"]').getByRole('button', { name: '复制', exact: true }).last().click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(short)
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  expect((await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)).toMatchObject({
    content: short,
    status: 'done'
  })
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /积微助手/)
  await page.getByText(conversation.title, { exact: true }).first().click()
  await expect(page.locator('main .chat-md').last()).toHaveText(short)
  await expect(page.locator('main .chat-md [data-sd-animate]')).toHaveCount(0)
})

test('a fast buffered reply animates the final character before settling', async () => {
  await launch(0, 512)
  const burst = '一次收到较长回复时也要让每个新增字符完整晕开。'.repeat(6) + '终'
  model.setAnswer(burst)
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }))
  const body = page.locator('main .chat-md').last()
  await expect(body).toHaveText(burst)
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { replyBlurEvents: BlurEvent[] }).replyBlurEvents.some((event) => event.text === '终'))
    )
    .toBe(true)
  await expect(body.locator('[data-sd-animate]')).toHaveCount(0)
  await expect(body).toHaveText(burst)
})

test('settling a completed reply preserves a text selection made while its last characters reveal', async () => {
  await launch(0, 512)
  const burst = '一次收到较长回复时也要保留读者选中的前文。'.repeat(9)
  model.setAnswer(burst)
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }))
  const body = page.locator('main .chat-md').last()
  await expect(body).toHaveText(burst)
  await expect(body).not.toHaveAttribute('data-streaming', 'true')
  await body.evaluate((node) => {
    const glyphs = node.querySelectorAll('[data-sd-animate]')
    const range = document.createRange()
    range.setStart(glyphs[0].firstChild!, 0)
    range.setEnd(glyphs[7].firstChild!, 1)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('一次收到较长回复')
  await expect(body.locator('[data-sd-animate]')).toHaveCount(0)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('一次收到较长回复')
})

test('reduced motion immediately removes blur while the response keeps streaming', async () => {
  await launch()
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }))
  const body = page.locator('main .chat-md').last()
  await expectCharacterBlur(body)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(body).toHaveAttribute('data-streaming', 'true')
  const glyphs = body.locator('[data-sd-animate]')
  expect(await glyphs.count()).toBeGreaterThan(0)
  expect(
    await glyphs.evaluateAll((nodes) =>
      nodes.every((node) => {
        const style = getComputedStyle(node)
        return style.animationName === 'none' && style.opacity === '1' && style.filter === 'none'
      })
    )
  ).toBe(true)
  const before = (await body.textContent())!.length
  await expect.poll(async () => (await body.textContent())!.length).toBeGreaterThan(before + 12)
  expect(await body.evaluate((node) => node.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running'))).toBe(
    false
  )
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
})

test('a transport failure leaves the received text clear and saved with its real error state', async () => {
  await launch()
  await send(page.getByRole('textbox', { name: '问积微，或交代一件事……', exact: true }))
  const body = page.locator('main .chat-md').last()
  await expectCharacterBlur(body)
  model.server.closeAllConnections()
  const conversation = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)?.status).toBe('error')
  const saved = (await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)).at(-1)!
  expect(saved.content.length).toBeGreaterThan(0)
  expect(saved.error).toBeTruthy()
  await expect(body).toContainText('首段逐字晕开')
  await expect(body.locator('[data-sd-animate]')).toHaveCount(0)
})
