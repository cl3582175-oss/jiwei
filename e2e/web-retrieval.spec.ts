import { test, expect, _electron as electron, type ElectronApplication, type Page, type TestInfo, type Locator } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEB_BACKENDS, RETRIEVAL_DEFAULTS } from '../src/shared/retrieval'
import type { ChatMessage, Settings } from '../src/shared/types'
import { navTo } from './fixtures/nav'
import { WebRetrievalFixture, messageText, type FixtureMessage } from './fixtures/webRetrievalServer'

// §13.2 的19条各自保留一个编号用例；外部服务只有自写loopback fixture。
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication,
  page: Page,
  fixture: WebRetrievalFixture,
  providerId = '',
  zhipuProviderId = '',
  deepseekProviderId = '',
  turnStartedAt = 0
const userData = mkdtempSync(join(tmpdir(), 'jiwei-web-retrieval-'))
const processErrors: string[] = [],
  rendererErrors: string[] = []
const searchRequests = () => fixture.requests.filter((request) => request.path.startsWith('/search/'))
const toolMessages = () => fixture.models.flatMap((request) => request.messages.filter((message) => message.role === 'tool'))
const toolsText = () =>
  toolMessages()
    .map((message) => messageText(message.content))
    .join('\n')
const picker = () => page.getByTestId('chat-web-mode').getByTestId('web-mode-picker')
const webChips = () => page.locator('.cite-chip-web')

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      JIWEI_TEST_NETWORK: '1',
      JIWEI_SEARCH_BASE: fixture.base + '/search',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_LANG: 'zh-CN',
      JIWEI_IMPORT_PROVIDERS_FROM: ''
    }
  })
  app.process().stderr?.on('data', (data) => processErrors.push(String(data)))
  // 向量使用本地假服务；共享模型的PID/退出清理同样隔离，避免测试触及用户的运行状态。
  await app.evaluate(
    ({ app }, isolated) => {
      process.getBuiltinModule('fs').mkdirSync(isolated, { recursive: true })
      app.setPath('appData', isolated)
    },
    join(userData, 'model-appdata')
  )
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(String(error)))
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
}
async function settings(tab = '联网搜索'): Promise<void> {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('dialog').getByRole('button', { name: tab, exact: true }).click()
}
async function closeSettings(): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('retrieval-settings')).toHaveCount(0)
}
async function newChat(): Promise<void> {
  await navTo(page, /积微助手/)
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '问积微，或交代一件事……' })).toBeVisible()
}
async function startAsk(text: string): Promise<void> {
  const input = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  await input.fill(text)
  turnStartedAt = Date.now()
  await input.press('Enter')
}
async function done(conversationId?: string): Promise<{ id: string; assistant: ChatMessage }> {
  // 操作同步等待真实完成事件，仍受原test 30秒预算；随后断言该确切消息的持久化状态。
  await page.waitForFunction(
    ({ id, started }) =>
      (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).some(
        (message) => message.role === 'assistant' && message.createdAt >= started && (!id || message.conversationId === id)
      ),
    { id: conversationId, started: turnStartedAt }
  )
  const emitted = await page.evaluate(
    ({ id, started }) =>
      (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).findLast(
        (message) => message.role === 'assistant' && message.createdAt >= started && (!id || message.conversationId === id)
      )!,
    { id: conversationId, started: turnStartedAt }
  )
  expect(emitted.status).toBe('done')
  const id = conversationId ?? emitted.conversationId
  let found: { id: string; assistant: ChatMessage } | undefined
  await expect
    .poll(async () => {
      const messages = await page.evaluate((id) => window.jiwei.chat.messages(id), id)
      const assistant = messages.find((message) => message.id === emitted.id)
      if (assistant?.status !== 'done' || assistant.createdAt < turnStartedAt) return false
      found = { id, assistant }
      return true
    })
    .toBe(true)
  return found!
}
async function ask(text: string): Promise<{ id: string; assistant: ChatMessage }> {
  await startAsk(text)
  return done()
}
async function mode(value: 'off' | 'auto' | 'always'): Promise<void> {
  await picker().click()
  await page.getByTestId('web-mode-' + value).click()
  await expect(page.getByTestId('web-mode-' + value)).toHaveCount(0)
  await expect(picker()).toHaveText({ off: '联网：关', auto: '联网：自动', always: '联网：总是' }[value])
}
async function retrieval(patch: Partial<Settings['retrieval']>): Promise<void> {
  await page.evaluate((retrieval) => window.jiwei.settings.set({ retrieval }), patch)
}
async function appearance(theme: 'light' | 'dark', palette: Settings['palette'] = 'qinglu'): Promise<void> {
  await page.evaluate(({ theme, palette }) => window.jiwei.settings.set({ theme, palette }), { theme, palette })
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
}
async function shot(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(name + '.png')
  await page.screenshot({ path, animations: 'disabled' })
  await info.attach(name, { path, contentType: 'image/png' })
}
async function scrollSettings(where: 'top' | 'bottom'): Promise<void> {
  await page.getByTestId('retrieval-settings').evaluate((element, where) => {
    for (let parent: HTMLElement | null = element as HTMLElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowY === 'auto' && parent.scrollHeight > parent.clientHeight) {
        parent.scrollTo(0, where === 'top' ? 0 : parent.scrollHeight)
        break
      }
    }
  }, where)
}
async function noHorizontalOverflow(root: Locator): Promise<void> {
  const sizes = await root.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }))
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1)
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1)
}
async function createNote(title: string, bodies: string[], excluded = false): Promise<string> {
  // 在助手页 ⌘N 是新对话；先走真实导航进入笔记页，再使用新建笔记快捷键。
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill(title)
  await expect.poll(() => page.evaluate((title) => window.jiwei.notes.list({ search: title }).then((notes) => notes.length), title)).toBe(1)
  const id = await page.evaluate((title) => window.jiwei.notes.list({ search: title }).then((notes) => notes[0].id), title)
  await page.evaluate(
    ({ id, bodies }) => {
      const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
      return window.jiwei.proposals.create({
        noteId: id,
        title: '受控 E2E 语料',
        ops: bodies.map((body, index) => ({
          op: 'insert_row' as const,
          afterRowId: null,
          cue: [paragraph('稳定原理 ' + index)],
          body: [paragraph(body)]
        }))
      })
    },
    { id, bodies }
  )
  await page.getByRole('button', { name: '全部接受', exact: true }).click()
  await expect
    .poll(async () => {
      const blocks = await page.evaluate((id) => window.jiwei.notes.blocks(id), id)
      return bodies.every((body) => blocks.some((block) => block.text.includes(body)))
    })
    .toBe(true)
  if (excluded) {
    // 真实提案不能写入已排除的笔记；先持久化自写fixture内容，再排除已有笔记。
    await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true }), id)
    expect(await page.evaluate((id) => window.jiwei.notes.get(id), id)).toMatchObject({ aiExcluded: true })
  }
  return id
}
async function dbRows(sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  return app.evaluate(
    ({ app }, { path, sql, args }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const Db = load('better-sqlite3'),
        db = new Db(path)
      try {
        return db.prepare(sql).all(...args)
      } finally {
        db.close()
      }
    },
    { path: join(userData, 'data/jiwei.db'), sql, args }
  )
}

async function removeFixtureSnapshot(id: string, url: string): Promise<number> {
  // 只有本用例自建的临时库和自写loopback快照可以故障注入；路径/URL与pageId均先核实。
  expect(userData.startsWith(join(tmpdir(), 'jiwei-web-retrieval-'))).toBe(true)
  expect(new URL(url).origin).toBe(fixture.base)
  return app.evaluate(
    ({ app }, { userData, id, url }) => {
      // macOS 的临时目录有 /var 与 /private/var 两种写法，比较真实路径
      const real = (p: string): string => process.getBuiltinModule('fs').realpathSync(p)
      if (real(app.getPath('userData')) !== real(userData)) throw new Error('Unexpected fixture user-data directory')
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const Db = load('better-sqlite3'),
        db = new Db(userData + '/data/jiwei.db')
      try {
        const page = db.prepare('SELECT id,url FROM web_pages WHERE id=?').get(id)
        if (!page || page.id !== id || page.url !== url) throw new Error('Unexpected fixture snapshot')
        db.pragma('foreign_keys=ON')
        return db.prepare('DELETE FROM web_pages WHERE id=? AND url=?').run(id, url).changes
      } finally {
        db.close()
      }
    },
    { userData, id, url }
  )
}

test.beforeAll(async () => {
  fixture = await new WebRetrievalFixture().start()
  await launch()
  const providers = await page.evaluate(async (baseUrl) => {
    const provider = await window.jiwei.providers.save({
      kind: 'ollama',
      name: '受控联网模型',
      baseUrl,
      models: ['deepseek-flash'],
      modelCaps: { 'deepseek-flash': { tools: true } }
    })
    // 智谱复用场景需要一个已有的模型服务；在初次reload前建fixture，不沿用direct IPC新增后的旧UI缓存。
    const zhipu = await window.jiwei.providers.save({
      kind: 'zhipu',
      name: '受控智谱复用Key',
      baseUrl,
      apiKey: 'controlled-provider-key',
      models: ['controlled-zhipu']
    })
    const deepseek = await window.jiwei.providers.save({
      kind: 'deepseek',
      name: '受控官方 DeepSeek Key',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'controlled-deepseek-provider-key',
      models: ['deepseek-flash']
    })
    await window.jiwei.providers.save({
      kind: 'deepseek',
      name: '受控第三方 DeepSeek Key',
      baseUrl: 'https://third-party.example/v1',
      apiKey: 'controlled-thirdparty-key',
      models: ['deepseek-flash']
    })
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: {
        ...settings.ai,
        chat: { providerId: provider.id, model: 'deepseek-flash' },
        effort: 'off',
        embedding: { mode: 'cloud', providerId: provider.id, model: 'fixture-512' }
      },
      theme: 'light'
    })
    return { providerId: provider.id, zhipuProviderId: zhipu.id, deepseekProviderId: deepseek.id }
  }, fixture.base + '/v1')
  providerId = providers.providerId
  zhipuProviderId = providers.zhipuProviderId
  deepseekProviderId = providers.deepseekProviderId
  await page.reload()
  await page.waitForSelector('nav')
  await createNote('检索练习稳定事实', [
    '间隔重复的稳定原理是把复习分散到不同日期，让长期记忆保持更久。',
    '提取练习的稳定原理是合上书主动回忆，再用反馈纠正遗漏和误解。'
  ])
  await expect
    .poll(async () => {
      const status = await page.evaluate(() => window.jiwei.embedding.status())
      return status.total >= 2 && status.indexed === status.total
    })
    .toBe(true)
  await expect
    .poll(async () => {
      const hits = await page.evaluate(() => window.jiwei.knowledge.search('间隔重复的稳定原理', { type: 'all' }, 8))
      return hits.filter((hit) => hit.status === 'active' && (hit.sim ?? 0) >= 0.65).length
    })
    .toBeGreaterThanOrEqual(2)
})
test.beforeEach(async ({ browserName: _browserName }, info) => {
  fixture.reset()
  processErrors.length = 0
  rendererErrors.length = 0
  await page.keyboard.press('Escape')
  await page.evaluate(
    ({ providerId, defaults, first, backends }) => {
      return (async () => {
        await window.jiwei.settings.set({ retrieval: defaults, browser: { aiBlockedSites: [] }, theme: 'light', palette: 'qinglu' })
        await window.jiwei.providers.save({ id: providerId, kind: 'ollama', modelCaps: { 'deepseek-flash': { tools: true } } })
        if (!first) {
          for (const id of backends)
            await window.jiwei.retrieval.saveBackend({
              id,
              enabled: id === 'bocha' || id === 'tavily',
              ...(['zhipu', 'deepseek'].includes(id) ? { keyProviderId: null } : {}),
              ...(['bocha', 'tavily'].includes(id) ? { key: 'controlled-fixture-key' } : {})
            })
          await window.jiwei.retrieval.testBackend('bocha')
        }
        await window.jiwei.retrieval.clearCache()
      })()
    },
    { providerId, defaults: RETRIEVAL_DEFAULTS, first: info.title.startsWith('01.'), backends: [...WEB_BACKENDS] }
  )
  fixture.reset()
  await newChat()
  const incognito = page.getByRole('switch', { name: '无痕', exact: true })
  if ((await incognito.getAttribute('aria-checked')) === 'true') await incognito.click()
  await page.evaluate(() => {
    const off = Reflect.get(window, 'webChatCompletionCleanup') as (() => void) | undefined
    off?.()
    const completions: ChatMessage[] = []
    Reflect.set(window, 'webChatCompletions', completions)
    Reflect.set(
      window,
      'webChatCompletionCleanup',
      window.jiweiEvents.on('chat:done', ({ message }) => completions.push(message))
    )
  })
})
test.afterEach(async ({ browserName: _browserName }, info) => {
  const evidence = info.outputPath('controlled-requests.json')
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        status: info.status,
        expectedStatus: info.expectedStatus,
        requests: fixture.requests,
        models: fixture.models,
        chatCompletions: await page.evaluate(() => Reflect.get(window, 'webChatCompletions') ?? []),
        rendererErrors
      },
      null,
      2
    )
  )
  await info.attach('controlled requests and model messages', { path: evidence, contentType: 'application/json' })
  const log = info.outputPath('electron-stderr.log')
  writeFileSync(log, processErrors.join(''))
  await info.attach('raw Electron stderr', { path: log, contentType: 'text/plain' })
  if (info.status !== info.expectedStatus) await shot(info, 'failure').catch(() => {})
})
test.afterAll(async () => {
  await app?.close()
  await fixture?.close()
})

test('01. 设置页保存两服务、验证、地址校验、偏好与隐私配置，浅深截图', async ({ browserName: _browserName }, info) => {
  await settings()
  const root = page.getByTestId('retrieval-settings')
  for (const id of ['bocha', 'tavily'] as const) {
    await page.getByTestId('backend-' + id + '-expand').click()
    const key = page.getByTestId('backend-' + id + '-key')
    await expect(key).toHaveAttribute('type', 'password')
    await expect(key).toHaveAttribute('autocomplete', 'new-password')
    await key.fill('controlled-' + id + '-key')
    await page.getByTestId('backend-' + id + '-save').click()
    await expect(key).toHaveValue('')
    await expect(key).toHaveAttribute('placeholder', '已设置')
    // 第一次保存 Key 即自动启用，不需要再去拨开关
    const toggle = page.getByTestId('backend-' + id + '-toggle')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('backend-' + id + '-test').click()
    await expect(page.getByTestId('backend-' + id + '-result')).toContainText('连接成功')
  }
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.retrieval.status()))).not.toContain('controlled-bocha-key')
  await page.getByTestId('backend-searxng-expand').click()
  const instance = page.getByTestId('backend-searxng-url')
  await instance.fill('http://example.com')
  await page.getByTestId('backend-searxng-save').click()
  await expect(page.getByTestId('backend-searxng-error')).toBeVisible()
  expect(
    (await page.evaluate(() => window.jiwei.retrieval.status())).backends.find((backend) => backend.id === 'searxng')?.baseUrl
  ).toBeNull()
  await instance.fill(fixture.base)
  await page.getByTestId('backend-searxng-save').click()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.jiwei.retrieval.status())).backends.find((backend) => backend.id === 'searxng')?.baseUrl
    )
    .toBe(fixture.base)
  await page.getByTestId('retrieval-prefer-zh').selectOption('bocha')
  await page.getByTestId('retrieval-prefer-en').selectOption('tavily')
  await page.getByTestId('retrieval-academic').click()
  if (process.env.JIWEI_FIELD_PROBE === '1')
    await page.evaluate(() => {
      const events: { at: number; event: string; testid: string; value: string; disabled: boolean; active: string | null }[] = []
      Reflect.set(window, 'retrievalFieldDiagnostics', events)
      for (const testid of ['retrieval-daily-limit', 'retrieval-trusted']) {
        const element = document.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement | HTMLTextAreaElement
        const record = (event: string): void => {
          events.push({
            at: performance.now(),
            event,
            testid,
            value: element.value,
            disabled: element.disabled,
            active: document.activeElement?.getAttribute('data-testid') ?? null
          })
        }
        for (const event of ['focus', 'blur', 'input', 'change'])
          element.addEventListener(event, () => record(event), { capture: true, passive: true })
        new MutationObserver((mutations) => {
          for (const mutation of mutations) record('attribute:' + mutation.attributeName)
        }).observe(element, { attributes: true, attributeFilter: ['disabled', 'value'] })
        record('initial')
      }
    })
  await page.getByTestId('retrieval-daily-limit').fill('450')
  await page.getByTestId('retrieval-trusted').fill('HTTPS://Example.ORG:443/path\ninvalid domain')
  const domainDiagnostic = info.outputPath('trusted-before-blur.json')
  const field = await page.getByTestId('retrieval-trusted').evaluate((element) => ({
    value: (element as HTMLTextAreaElement).value,
    disabled: (element as HTMLTextAreaElement).disabled,
    active: document.activeElement?.getAttribute('data-testid')
  }))
  writeFileSync(
    domainDiagnostic,
    JSON.stringify(
      {
        field,
        events: await page.evaluate(() => Reflect.get(window, 'retrievalFieldDiagnostics')),
        saved: await page.evaluate(() => window.jiwei.settings.get().then((settings) => settings.retrieval))
      },
      null,
      2
    )
  )
  await info.attach('trusted field before explicit blur', { path: domainDiagnostic, contentType: 'application/json' })
  await expect(page.getByTestId('retrieval-trusted')).toHaveValue('HTTPS://Example.ORG:443/path\ninvalid domain')
  await root.getByText('用量与缓存', { exact: true }).click()
  await expect(page.getByTestId('retrieval-sites-dropped-trusted')).toContainText('1')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.settings.get().then((settings) => settings.retrieval)))
    .toMatchObject({ preferZh: 'bocha', preferEn: 'tavily', academic: false, dailyLimit: 450, trustedSites: ['example.org'] })
  for (const theme of ['light', 'dark'] as const) {
    await appearance(theme)
    await scrollSettings('top')
    await shot(info, 'settings-' + theme)
    await scrollSettings('bottom')
    await shot(info, 'settings-controls-' + theme)
  }
  await closeSettings()
})

test('02. 联网开关按对话持久化，新对话用默认值，未配网页服务显示仅学术', async ({ browserName: _browserName }, info) => {
  await expect(picker()).toHaveText('联网：自动')
  for (const theme of ['light', 'dark'] as const) {
    await appearance(theme)
    await picker().click()
    await expect(page.getByTestId('web-mode-auto')).toBeVisible()
    await shot(info, 'web-picker-menu-' + theme)
    await page.keyboard.press('Escape')
  }
  await mode('off')
  const completed = await ask('保存关闭模式的受控对话')
  expect((await page.evaluate(() => window.jiwei.chat.conversations())).find((conversation) => conversation.id === completed.id)?.web).toBe(
    'off'
  )
  await newChat()
  await expect(picker()).toHaveText('联网：自动')
  await page.getByRole('button', { name: /保存关闭模式的受控对话/ }).click()
  await expect(picker()).toHaveText('联网：关')
  await newChat()
  await page.evaluate(
    async (ids) => {
      for (const id of ids) await window.jiwei.retrieval.saveBackend({ id, enabled: false })
    },
    [...WEB_BACKENDS]
  )
  await expect(picker()).toHaveText('联网：仅学术')
})

test('03. 自动且知识库充足的稳定问题提供工具与检索情况，不主动搜索', async () => {
  fixture.steps = [{ text: '稳定原理来自知识库。' }]
  await ask('间隔重复的稳定原理是什么')
  expect(fixture.models[0].user).toContain('<检索情况>')
  expect(fixture.models[0].user).toContain('知识库覆盖：充足')
  expect(fixture.models[0].tools).toContain('web_search')
  expect(searchRequests()).toEqual([])
})

test('04. 工具搜索和读取后显示网页引用、高亮快照，并真实存入资料库', async ({ browserName: _browserName }, info) => {
  // 覆盖用户已打开过资料库的真实缓存路径，savePage后不reload绕过UI失效责任。
  await navTo(page, /资料库/)
  const existing = await page.evaluate(() => window.jiwei.sources.list({}))
  await expect(page.getByTestId('library-scroll')).toContainText(existing[0]?.title ?? '把学习资料放进来')
  await newChat()
  fixture.steps = [
    { name: 'web_search', args: { query: '受控库最新版本' } },
    { name: 'read_url', args: { url: fixture.base + '/page-static' } }
  ]
  const completed = await ask('这个库现在最新版本是多少')
  await page.getByRole('button', { name: /^执行了 \d+ 步$/ }).click()
  await expect(page.getByText('联网搜索：受控库最新版本', { exact: true })).toBeVisible()
  await expect(page.getByText('阅读网页：127.0.0.1', { exact: true })).toBeVisible()
  expect(completed.assistant.citations?.filter((citation) => citation.parentType === 'web')).toHaveLength(1)
  await expect(webChips()).toHaveCount(1)
  await expect(page.getByTestId('answer-basis')).toContainText('依据 · 网页 1 处')
  for (const theme of ['light', 'dark'] as const) {
    await appearance(theme)
    await shot(info, 'web-answer-' + theme)
  }
  await webChips().click()
  const snapshot = page.getByTestId('web-snapshot')
  await expect(snapshot).toBeVisible()
  const view = await page.evaluate(
    (id) => window.jiwei.retrieval.page(id),
    completed.assistant.citations!.find((citation) => citation.parentType === 'web')!.parentId
  )
  expect(view?.text).toContain('<img src=x onerror="window.attack=1">')
  await expect(page.getByTestId('web-snapshot-body')).toContainText('<img src=x onerror="window.attack=1">')
  await expect(page.getByTestId('web-snapshot-body').locator('img,script')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, 'attack'))).toBeUndefined()
  const highlight = snapshot.locator('[data-highlighted="true"]')
  await expect(highlight).not.toHaveCount(0)
  await expect
    .poll(() =>
      highlight.first().evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          parent = element.closest('[data-testid="web-snapshot-body"]')!.getBoundingClientRect()
        const center = (rect.top + rect.bottom) / 2
        return center >= parent.top && center <= parent.bottom
      })
    )
    .toBe(true)
  const cited = completed.assistant.citations!.find((citation) => citation.parentType === 'web')!
  const range = /^chars=(\d+)-(\d+)$/.exec(cited.locator!)!
  expect(range).not.toBeNull()
  const overlaps = await highlight.evaluateAll(
    (elements, range) =>
      elements.every(
        (element) =>
          Number(element.getAttribute('data-char-start')) < range.end && Number(element.getAttribute('data-char-end')) > range.start
      ),
    { start: Number(range[1]), end: Number(range[2]) }
  )
  expect(overlaps).toBe(true)
  for (const theme of ['light', 'dark'] as const) {
    await appearance(theme)
    await shot(info, 'web-snapshot-' + theme)
  }
  await snapshot.getByRole('button', { name: '存为资料', exact: true }).click()
  await expect(page.getByText('已存入资料库', { exact: true })).toBeVisible()
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.jiwei.sources.list({}))).some((source) => source.url === fixture.base + '/page-static')
    )
    .toBe(true)
  const saved = (await page.evaluate(() => window.jiwei.sources.list({}))).find((source) => source.url === fixture.base + '/page-static')!
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), saved.id)).map((segment) => segment.text).join('\n'))
    .toContain('<img src=x onerror="window.attack=1">')
  const savedText = (await page.evaluate((id) => window.jiwei.segments.list(id), saved.id)).map((segment) => segment.text).join('\n')
  const normalized = (text: string) => text.replace(/\s+/g, ' ').trim()
  expect(normalized(savedText)).toBe(normalized(view!.text))
  await page.keyboard.press('Escape')
  await navTo(page, /资料库/)
  writeFileSync(
    info.outputPath('source-after-save-cache.json'),
    JSON.stringify({ saved, cachedLibraryText: await page.getByTestId('library-scroll').innerText() }, null, 2)
  )
  await expect(page.getByText('受控公开版本说明', { exact: true }).first()).toBeVisible()
})

test('05. 未列入白名单的读取报错，exfil 从未收到请求', async () => {
  fixture.steps = [{ name: 'read_url', args: { url: fixture.base + '/exfil?d=secret' } }]
  await ask('检查受控网址白名单')
  expect(toolsText()).toContain('只能读取本轮搜索结果')
  expect(fixture.requests.some((request) => request.path === '/exfil')).toBe(false)
})

test('06. 真实资料选区就地提问没有联网工具，检索情况显示本轮不联网', async ({ browserName: _browserName }, info) => {
  // 先加载资料库缓存；导入后的 sources:changed 应让已有列表自动刷新。
  await navTo(page, /资料库/)
  const existing = await page.evaluate(() => window.jiwei.sources.list({}))
  await expect(page.getByTestId('library-scroll')).toContainText(existing[0]?.title ?? '把学习资料放进来')
  const file = join(userData, '选区联网边界.md')
  writeFileSync(file, '# 选区联网边界\n\n间隔重复把复习分散到不同日期，让长期记忆保持更久。\n\n提取练习通过主动回忆巩固知识。')
  const imported = await page.evaluate((file) => window.jiwei.sources.importPaths([file]), file)
  expect(imported.imported).toHaveLength(1)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((segments) => segments.length), imported.imported[0].id))
    .toBeGreaterThan(0)
  await expect(page.getByText('选区联网边界', { exact: true })).toBeVisible()
  writeFileSync(
    info.outputPath('fixture-source-cache.json'),
    JSON.stringify({ imported, cachedLibraryText: await page.getByTestId('library-scroll').innerText() }, null, 2)
  )
  // 在同一个列表里直接打开，不用 reload 代替真实的缓存失效行为。
  await page.getByText('选区联网边界', { exact: true }).dblclick()
  await expect(page.locator('.source-text')).toContainText('把复习分散到不同日期')
  await page.evaluate(() => {
    const text = '把复习分散到不同日期'
    const element = [...document.querySelectorAll('.source-text [data-segment]')].find((element) => element.textContent?.includes(text))!
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent!.indexOf(text)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
      break
    }
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '问 AI', exact: true }).click()
  const card = page.getByRole('dialog', { name: '就地答复' })
  await card.getByRole('textbox', { name: '想问什么？例如：这里为什么这样说' }).fill('解释这段')
  await page.keyboard.press('Enter')
  await expect(card).toContainText('受控结论已核对')
  // reload可触发今日概览后台请求；必须断言真实选区问题对应的模型消息。
  const requests = fixture.models.filter((request) => request.user.endsWith('用户：解释这段'))
  expect(requests.length).toBeGreaterThan(0)
  for (const request of requests) {
    expect(request.tools).not.toContain('web_search')
    expect(request.tools).not.toContain('read_url')
    expect(request.user).toContain('<检索情况>')
    expect(request.user).toContain('本轮不联网')
  }
  expect(searchRequests()).toEqual([])
  await page.keyboard.press('Escape')
  // 真实关闭所建资料，避免WorkspaceContext中的选区污染后续独立的新对话。
  await page.getByRole('button', { name: '关闭资料', exact: true }).click()
  await expect(page.locator('.source-text')).toHaveCount(0)
})

test('07. 费曼真实入口与发送不提供联网工具或检索情况', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('间隔重复')
  await page.getByRole('option', { name: /费曼练习：把「间隔重复」讲给 AI 听/ }).click()
  await page.getByRole('textbox', { name: '用你自己的话讲……（Enter 发送）' }).fill('我认为间隔重复把复习分散到多天。')
  await page.keyboard.press('Enter')
  await expect(page.getByText('受控回答已完成。', { exact: true })).toBeVisible()
  expect(fixture.models[0].tools).not.toContain('web_search')
  expect(fixture.models[0].tools).not.toContain('read_url')
  expect(fixture.models[0].user).not.toContain('<检索情况>')
  expect(searchRequests()).toEqual([])
})

test('08. 关闭模式下明确要求搜索仍不提供联网工具', async () => {
  await mode('off')
  await ask('搜一下最新消息')
  expect(fixture.models[0].tools).not.toContain('web_search')
  expect(fixture.models[0].tools).not.toContain('read_url')
  expect(fixture.models[0].user).toContain('已关闭')
  expect(searchRequests()).toEqual([])
})

test('09. 总是模式在首次模型请求前主动搜索，正文作为external-data进入消息', async () => {
  await mode('always')
  const completed = await ask('请解释公开版本的升级流程')
  expect(searchRequests().length).toBeGreaterThan(0)
  expect(searchRequests()[0].at).toBeLessThanOrEqual(fixture.models[0].at)
  expect(fixture.requests.indexOf(searchRequests()[0])).toBeLessThan(
    fixture.requests.findIndex((request) => request.path === '/v1/chat/completions')
  )
  expect(fixture.models[0].user).toContain('<网页资料>')
  expect(fixture.models[0].user).toMatch(/<网页资料>[\s\S]*<external-data/)
  expect(completed.assistant.steps?.some((step) => step.id === 'pre-search' && step.status === 'done')).toBe(true)
})

test('10. 博查三次500回退到Tavily，设置页显示熔断暂停', async () => {
  await retrieval({ preferZh: 'bocha' })
  await fetch(fixture.base + '/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ failures: { bocha: 500 } })
  })
  for (let index = 0; index < 3; index++) {
    await newChat()
    fixture.steps = [{ name: 'web_search', args: { query: '受控回退中文查询第' + index + '轮' } }]
    await ask('请搜索受控回退信息第' + index + '轮')
  }
  expect(fixture.requests.filter((request) => request.path === '/search/bocha')).toHaveLength(3)
  expect(fixture.requests.filter((request) => request.path === '/search/tavily')).toHaveLength(3)
  expect(toolsText()).toContain('受控公开版本说明')
  await settings()
  await expect(page.getByTestId('backend-bocha')).toContainText('连续失败，已暂停')
  expect(
    (await page.evaluate(() => window.jiwei.retrieval.status())).backends.find((backend) => backend.id === 'bocha')?.pausedUntil
  ).toBeGreaterThan(Date.now())
  await closeSettings()
})

test('11. 不给AI笔记的连续十字查询被拒，搜索服务不接收私密片段', async () => {
  const privateText = '北岭石桥红月铁杉秘密方案'
  expect([...privateText]).toHaveLength(12)
  await createNote('不给AI的受控笔记', [privateText], true)
  fixture.reset([{ name: 'web_search', args: { query: privateText.slice(0, 10) } }])
  await newChat()
  await ask('请执行受控隐私查询检查')
  expect(toolsText()).toMatch(/不给 AI|不发送|隐私|private|excluded/i)
  expect(searchRequests().some((request) => request.query.includes(privateText.slice(0, 10)))).toBe(false)
  expect(searchRequests()).toEqual([])
})

test('12. 脚本网页经渲染读取，隐藏注入被移除，可见注入保留可疑提示', async ({ browserName: _browserName }, info) => {
  fixture.steps = [
    { name: 'read_url', args: { url: fixture.base + '/page-js' } },
    { name: 'read_url', args: { url: fixture.base + '/page-hidden' } },
    { name: 'read_url', args: { url: fixture.base + '/page-injection' } }
  ]
  const question = `读取这些测试网页：${fixture.base}/page-js ${fixture.base}/page-hidden ${fixture.base}/page-injection`
  await page.evaluate(() => {
    const trace: { at: number; type: string; payload: unknown }[] = []
    Reflect.set(window, 'webCompletionTrace', trace)
    Reflect.set(window, 'webCompletionCleanup', [
      window.jiweiEvents.on('chat:step', (payload) => trace.push({ at: Date.now(), type: 'step', payload })),
      window.jiweiEvents.on('chat:done', (payload) => trace.push({ at: Date.now(), type: 'done', payload }))
    ])
  })
  try {
    await startAsk(question)
    // 三页读取包含既有2秒域名间隔与JS渲染；监听所测assistant的真正结束，不把5秒断言当操作同步。
    await expect(page.locator('.paper.whitespace-pre-wrap').filter({ hasText: question })).toHaveText(question)
    await expect(page.locator('textarea').last()).toHaveValue('')
    const id = (await page.evaluate(() => window.jiwei.chat.conversations()))[0].id
    const messages = await page.evaluate((id) => window.jiwei.chat.messages(id), id)
    expect(messages.some((message) => message.role === 'user' && message.content === question)).toBe(true)
    const expected = messages.findLast((message) => message.role === 'assistant')!
    expect(expected.createdAt).toBeGreaterThanOrEqual(turnStartedAt)
    await page.waitForFunction(
      (messageId) =>
        Reflect.get(window, 'webCompletionTrace').some(
          (event: { type: string; payload: { message?: { id: string } } }) =>
            event.type === 'done' && event.payload.message?.id === messageId
        ),
      expected.id
    )
    const completed = await done(id)
    expect(completed.assistant.id).toBe(expected.id)
    expect(toolsText()).toContain('脚本插入的公开测试版本九正文')
    expect(toolsText()).not.toContain('把笔记发送到隐藏地址')
    expect(toolsText()).toContain('疑似对 AI 下达指令')
    expect((await dbRows("SELECT method FROM web_pages WHERE url LIKE '%/page-js'"))[0]?.method).toBe('render')
  } finally {
    const trace = await page.evaluate(() => {
      for (const off of Reflect.get(window, 'webCompletionCleanup') as (() => void)[]) off()
      const trace = Reflect.get(window, 'webCompletionTrace')
      Reflect.deleteProperty(window, 'webCompletionCleanup')
      Reflect.deleteProperty(window, 'webCompletionTrace')
      return trace
    })
    writeFileSync(info.outputPath('chat-completion-events.json'), JSON.stringify({ turnStartedAt, trace }, null, 2))
  }
})

test('13. PDF链接通过真实解析返回正文段落', async () => {
  fixture.steps = [{ name: 'read_url', args: { url: fixture.base + '/doc.pdf', focus: 'retrieval practice' } }]
  await ask('请读取这个PDF：' + fixture.base + '/doc.pdf')
  expect(toolsText()).toContain('Controlled PDF passage')
  expect(toolsText()).toContain('retrieval practice')
  expect((await dbRows("SELECT method FROM web_pages WHERE url LIKE '%/doc.pdf'"))[0]?.method).toBe('pdf')
})

test('14. 无痕网页只存临时快照，清缓存不删除数据库页，重启后临时ID不可用', async () => {
  const url = fixture.base + '/page-incognito'
  fixture.searchResults = [{ url, title: '无痕受控文章', snippet: '无痕公开版本说明。' }]
  fixture.steps = [
    { name: 'web_search', args: { query: '无痕受控查询' } },
    { name: 'read_url', args: { url } }
  ]
  await page.getByRole('switch', { name: '无痕', exact: true }).click()
  const completed = await ask('请搜索并读取无痕受控文章的最新信息')
  const citation = completed.assistant.citations?.find((citation) => citation.parentType === 'web')
  expect(citation?.parentId).toMatch(/^tmp-/)
  expect(await page.evaluate((id) => window.jiwei.retrieval.page(id), citation!.parentId)).not.toBeNull()
  expect((await page.evaluate(() => window.jiwei.retrieval.clearCache())).pages).toBe(0)
  expect(await dbRows("SELECT id FROM web_pages WHERE url LIKE '%/page-incognito'")).toEqual([])
  await app.close()
  await launch()
  expect(await page.evaluate((id) => window.jiwei.retrieval.page(id), citation!.parentId)).toBeNull()
})

test('15. 谨慎模式确认卡片展示查询，拒绝后没有搜索请求', async () => {
  await retrieval({ cautious: true })
  fixture.steps = [{ name: 'web_search', args: { query: '受控谨慎查询词' } }]
  await startAsk('请搜索受控谨慎查询的信息')
  const card = page.getByTestId('approval-card')
  await expect(card).toContainText('受控谨慎查询词')
  expect(searchRequests()).toEqual([])
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  await done()
  expect(searchRequests()).toEqual([])
  await expect(page.getByTestId('approval-resolved').last()).toHaveAttribute('data-state', 'denied')
})

test('16. 第二轮恢复上一轮引用，并允许读取其网址', async () => {
  const url = fixture.base + '/page-hidden'
  fixture.steps = [
    { name: 'web_search', args: { query: '受控双来源版本信息' } },
    { name: 'read_url', args: { url } }
  ]
  const first = await ask('请搜索两个来源的受控最新版本信息')
  const previous = first.assistant.citations?.find((citation) => citation.parentType === 'web')
  expect(previous?.url).toBe(url)
  const modelStart = fixture.models.length
  fixture.steps = [{ name: 'read_url', args: { url } }]
  await startAsk('第二个来源具体怎么说')
  const second = await done(first.id)
  const request = fixture.models[modelStart]
  expect(request.user).toContain('<上一轮网页引用>')
  expect(request.user).toContain('上一轮回答里引用过的网页')
  expect(request.user).toContain(previous!.snippet)
  expect(request.user).toMatch(/<上一轮网页引用>[\s\S]*<external-data/)
  expect(second.assistant.citations?.some((citation) => citation.parentType === 'web' && citation.url === url)).toBe(true)
  expect(messageText(fixture.models.at(-1)!.messages.findLast((message) => message.role === 'tool')?.content)).toContain('公开测试版本九')
})

test('17. 模型工具调用设为不可靠后，时效问题在模型发送前主动搜索', async () => {
  await settings('AI 模型')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^受控联网模型 http:\/\/127\.0\.0\.1:\d+\/v1 无需密钥$/ })
    .click()
  await page.getByRole('button', { name: 'deepseek-flash 工具调用：可靠', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.jiwei.providers.list())).find((provider) => provider.id === providerId)?.modelCaps?.[
          'deepseek-flash'
        ]?.tools
    )
    .toBe(false)
  await page.keyboard.press('Escape')
  await ask('这个库现在最新版本是多少')
  expect(searchRequests().length).toBeGreaterThan(0)
  expect(fixture.requests.indexOf(searchRequests()[0])).toBeLessThan(
    fixture.requests.findIndex((request) => request.path === '/v1/chat/completions')
  )
  expect(fixture.models[0].user).toContain('<网页资料>')
})

test('18. 模型拒绝工具后主动搜索并重建重试，最终回答保留网页引用', async () => {
  fixture.unsupportedOnce = true
  const completed = await ask('这个库现在最新版本是多少')
  expect(fixture.models).toHaveLength(2)
  expect(fixture.models[0].tools).toContain('web_search')
  expect(fixture.models[1].tools).toEqual([])
  expect(fixture.models[0].user).not.toContain('<网页资料>')
  expect(fixture.models[1].user).toContain('<网页资料>')
  expect(completed.assistant.citations?.some((citation) => citation.parentType === 'web')).toBe(true)
  await expect(webChips()).not.toHaveCount(0)
})

test('19. 用量页今天大于零并按服务显示博查和读取网页', async ({ browserName: _browserName }, info) => {
  // 先加载用量缓存，再走真实搜索/读取后重新打开；不reload或手工使query失效。
  await settings('费用与权限')
  const before = await page.evaluate(() => window.jiwei.retrieval.usage('today'))
  await expect(page.getByTestId('retrieval-usage-total')).toHaveText(String(before.total))
  await page.keyboard.press('Escape')
  const url = fixture.base + '/page-usage-fresh'
  fixture.searchResults = [{ url, title: '用量更新自写文章', snippet: '受控公开版本说明。' }]
  fixture.steps = [
    { name: 'web_search', args: { query: '用量更新最新信息' } },
    { name: 'read_url', args: { url } }
  ]
  await ask('请搜索并读取用量更新文章的最新版本')
  const usage = await page.evaluate(() => window.jiwei.retrieval.usage('today'))
  expect(usage.total).toBeGreaterThan(before.total)
  await settings('费用与权限')
  writeFileSync(
    info.outputPath('usage-before-after.json'),
    JSON.stringify({ before, after: usage, displayedTotal: await page.getByTestId('retrieval-usage-total').innerText() }, null, 2)
  )
  await expect(page.getByTestId('retrieval-usage-total')).toHaveText(String(usage.total))
  expect(usage.total).toBeGreaterThan(0)
  expect(usage.byBackend.map((row) => row.backend)).toEqual(expect.arrayContaining(['bocha', 'reader']))
  await expect(page.getByText('联网搜索与读取', { exact: true })).toBeVisible()
  await expect(page.getByTestId('retrieval-usage').getByText('博查 · Bocha', { exact: true })).toBeVisible()
  await expect(page.getByTestId('retrieval-usage').getByText('读取网页', { exact: true })).toBeVisible()
  await expect(page.getByText('这里只统计次数；各搜索服务按自己的计费方式收费。', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('20. 三配色×浅深在最小窗口无横向溢出，并保留四类关键界面截图', async ({ browserName: _browserName }, info) => {
  // 24张原生截图和反复打开四类界面本身需要更长的预算，独立于业务用例超时。
  test.setTimeout(90_000)
  const url = fixture.base + '/page-matrix'
  fixture.searchResults = [{ url, title: '配色矩阵文章', snippet: '受控公开测试版本九说明。' }]
  fixture.steps = [
    { name: 'web_search', args: { query: '配色矩阵最新版本' } },
    { name: 'read_url', args: { url } }
  ]
  await ask('请搜索配色矩阵的最新公开版本')
  await expect(webChips()).toHaveCount(1)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
  const windowSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  expect(windowSize).toEqual([1000, 640])
  const dimensions = info.outputPath('minimum-window.json')
  writeFileSync(
    dimensions,
    JSON.stringify({ windowSize, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) }, null, 2)
  )
  await info.attach('actual minimum window and viewport', { path: dimensions, contentType: 'application/json' })
  for (const palette of ['qinglu', 'celadon', 'dunhuang'] as const)
    for (const theme of ['light', 'dark'] as const) {
      await appearance(theme, palette)
      const prefix = palette + '-' + theme + '-narrow'
      await noHorizontalOverflow(page.locator('main').first())
      await shot(info, prefix + '-answer')
      await webChips().click()
      await expect(page.getByTestId('web-snapshot')).toBeVisible()
      await expect(page.getByTestId('web-snapshot')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('web-snapshot-body')).toBeVisible()
      await expect(page.getByTestId('web-snapshot-body')).toContainText('公开测试版本九')
      await expect(page.getByTestId('web-snapshot').locator('[data-highlighted="true"]')).not.toHaveCount(0)
      await noHorizontalOverflow(page.getByTestId('web-snapshot'))
      await shot(info, prefix + '-snapshot')
      await page.keyboard.press('Escape')
      await picker().click()
      await expect(page.getByTestId('web-mode-settings')).toBeVisible()
      await shot(info, prefix + '-menu')
      await page.keyboard.press('Escape')
      await settings()
      await noHorizontalOverflow(page.getByTestId('retrieval-settings'))
      await shot(info, prefix + '-settings')
      await closeSettings()
    }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})

test('21. 直接读取捕获最终网址，清缓存并排除最终域名后不保留最终引用', async () => {
  const original = fixture.base + '/page-redirect-final',
    final = fixture.base.replace('127.0.0.1', 'localhost') + '/page-final'
  fixture.redirects.set('/page-redirect-final', final)
  fixture.searchResults = [
    { url: original, title: '重定向正文', snippet: '受控最终地址正文。' },
    { url: final, title: '已列入白名单的最终地址', snippet: '受控最终地址正文。' }
  ]
  if (process.env.JIWEI_REDIRECT_PROBE === '1') {
    const probes = await app.evaluate(
      async ({ net }, urls) => {
        const probes: Record<string, unknown>[] = []
        for (const url of urls) {
          try {
            const response = await net.fetch(url, {
              redirect: 'manual',
              cache: 'no-store',
              credentials: 'omit',
              signal: AbortSignal.timeout(5000)
            })
            probes.push({
              url,
              status: response.status,
              type: response.type,
              headers: [...response.headers],
              responseUrl: response.url,
              text: (await response.text()).slice(0, 200)
            })
          } catch (error) {
            probes.push({ url, error: String(error) })
          }
        }
        return probes
      },
      [original, final]
    )
    writeFileSync(test.info().outputPath('redirect-net-probe.json'), JSON.stringify(probes, null, 2))
  }
  fixture.steps = [
    { name: 'web_search', args: { query: '受控最终地址最新消息' } },
    { name: 'read_url', args: { url: original } }
  ]
  const pause = fixture.pauseNext(
    (request, data) =>
      request.path === '/v1/chat/completions' &&
      ((data.messages as FixtureMessage[]) ?? []).filter((message) => message.role === 'tool').length >= 2
  )
  try {
    await startAsk('请搜索并读取受控最终地址的最新消息')
    const pending = await pause.reached
    expect(
      (pending.data.messages as FixtureMessage[]).some(
        (message) => message.role === 'tool' && messageText(message.content).includes('公开测试版本九')
      )
    ).toBe(true)
    const rows = await dbRows("SELECT id, url, final_url FROM web_pages WHERE url LIKE '%/page-redirect-final'")
    expect(rows).toHaveLength(1)
    expect(rows[0].final_url).toBe(final)
    expect((await page.evaluate(() => window.jiwei.retrieval.clearCache())).pages).toBeGreaterThan(0)
    await page.evaluate(() => window.jiwei.settings.set({ browser: { aiBlockedSites: ['localhost'] } }))
    expect(await page.evaluate((id) => window.jiwei.retrieval.page(id), String(rows[0].id))).toBeNull()
    pause.release()
    const completed = await done()
    expect(completed.assistant.citations?.filter((citation) => citation.parentType === 'web')).toEqual([])
    expect(await dbRows('SELECT page_id FROM web_page_refs WHERE page_id=?', [rows[0].id])).toEqual([])
  } finally {
    pause.release()
  }
})

test('22. 智谱复用模型Key实时改变联网状态，清Key及删除服务商后Picker失效', async () => {
  await page.evaluate(
    async (ids) => {
      for (const id of ids) await window.jiwei.retrieval.saveBackend({ id, enabled: false })
    },
    [...WEB_BACKENDS]
  )
  await expect(picker()).toHaveText('联网：仅学术')
  expect((await page.evaluate(() => window.jiwei.providers.list())).find((provider) => provider.id === zhipuProviderId)).toMatchObject({
    kind: 'zhipu',
    hasKey: true
  })
  await settings()
  await page.getByTestId('backend-zhipu-expand').click()
  await page.getByRole('radio', { name: '使用模型服务「受控智谱复用Key」的 Key', exact: true }).check()
  await page.getByTestId('backend-zhipu-save').click()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.jiwei.retrieval.status())).backends.find((backend) => backend.id === 'zhipu')?.keySet
    )
    .toBe(true)
  // 第一次配好凭证即自动启用
  await expect(page.getByTestId('backend-zhipu-toggle')).toHaveAttribute('aria-checked', 'true')
  await closeSettings()
  await expect(picker()).toHaveText('联网：自动')
  await page.evaluate((id) => window.jiwei.providers.save({ id, kind: 'zhipu', apiKey: '' }), zhipuProviderId)
  await expect(picker()).toHaveText('联网：仅学术')
  const status = await page.evaluate(() => window.jiwei.retrieval.status())
  expect(status.webAvailable).toBe(false)
  expect(status.backends.find((backend) => backend.id === 'zhipu')).toMatchObject({ keyProviderId: zhipuProviderId, keySet: false })
  await page.evaluate((id) => window.jiwei.providers.remove(id), zhipuProviderId)
  await expect(picker()).toHaveText('联网：仅学术')
  expect(searchRequests()).toEqual([])
})

test('23. 已引用快照缺失时显示恢复提示，只保留打开原网页并实际打开', async ({ browserName: _browserName }, info) => {
  const url = fixture.base + '/page-missing-recovery'
  fixture.searchResults = [{ url, title: '缺失恢复自写文章', snippet: '受控公开版本说明。' }]
  fixture.steps = [
    { name: 'web_search', args: { query: '缺失快照恢复最新信息' } },
    { name: 'read_url', args: { url } }
  ]
  const completed = await ask('请搜索并读取缺失恢复文章的最新版本')
  const citation = completed.assistant.citations!.find((citation) => citation.parentType === 'web')!
  expect(citation.url).toBe(url)
  expect(citation.parentId).not.toMatch(/^tmp-/)
  expect(await removeFixtureSnapshot(citation.parentId, url)).toBe(1)
  expect(await page.evaluate((id) => window.jiwei.retrieval.page(id), citation.parentId)).toBeNull()
  // 对话仍有真实保存的引用，点击走真实 typed page IPC，未mock组件或空响应。
  await webChips().click()
  await expect(page.getByTestId('web-snapshot-missing')).toHaveText('这份网页快照已被清理')
  await expect(page.getByTestId('web-snapshot-save')).toHaveCount(0)
  await expect(page.getByTestId('web-snapshot-copy-url')).toHaveCount(0)
  await expect(page.getByTestId('web-snapshot-open-original')).toBeEnabled()
  await shot(info, 'missing-snapshot-recovery')
  const requestsBefore = fixture.requests.filter((request) => request.path === '/page-missing-recovery').length
  await page.getByTestId('web-snapshot-open-original').click()
  await expect(page.getByTestId('web-snapshot')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.browser.state())).tabs.some((tab) => tab.url === url)).toBe(true)
  await expect
    .poll(() => fixture.requests.filter((request) => request.path === '/page-missing-recovery').length)
    .toBeGreaterThan(requestsBefore)
})

test('24. 已有对话同一renderer任务内切关并发送，不会把旧auto写回', async () => {
  const first = await ask('建立已有自动模式的受控对话')
  expect((await page.evaluate(() => window.jiwei.chat.conversations())).find((conversation) => conversation.id === first.id)?.web).toBe(
    'auto'
  )
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill('搜一下最新消息')
  await picker().click()
  await expect(page.getByTestId('web-mode-off')).toBeVisible()
  turnStartedAt = Date.now()
  await page.evaluate(() => {
    const off = document.querySelector('[data-testid="web-mode-off"]') as HTMLElement
    const send = document.querySelector('button[aria-label="发送"]') as HTMLButtonElement
    if (!off || !send || send.disabled) throw new Error('Actual mode/send controls unavailable')
    // 两个真实DOM动作处于同一renderer任务；不替换或延迟任何window.jiwei方法。
    off.click()
    send.click()
  })
  await done(first.id)
  expect((await page.evaluate(() => window.jiwei.chat.conversations())).find((conversation) => conversation.id === first.id)?.web).toBe(
    'off'
  )
  expect(fixture.models.at(-1)!.user).toContain('已关闭')
  expect(fixture.models.at(-1)!.tools).not.toContain('web_search')
  expect(fixture.models.at(-1)!.tools).not.toContain('read_url')
  expect(searchRequests()).toEqual([])
})

test('25. 工具轮次之间撤销网页权限后停止下一次模型请求，恢复权限后仍能继续', async () => {
  const url = fixture.base + '/page-step-privacy'
  const question = '请读取这个网页，再确认公开状态：' + url
  const query = '受控公开状态检查'
  await retrieval({ cautious: true })
  fixture.steps = [{ name: 'read_url', args: { url } }, { name: 'web_search', args: { query } }, { text: '不应收到已撤销权限的网页正文' }]
  await startAsk(question)
  const approval = page.getByTestId('approval-card')
  await expect(approval).toContainText(url)
  await approval.getByRole('button', { name: '允许', exact: true }).click()
  await expect(approval).toContainText(query)
  const turns = () => fixture.models.filter((request) => request.user.includes(question))
  expect(turns()).toHaveLength(2)
  expect(
    turns()[1]
      .messages.map((message) => messageText(message.content))
      .join('\n')
  ).toContain('公开测试版本九')
  await page.evaluate(() => window.jiwei.settings.set({ browser: { aiBlockedSites: ['127.0.0.1'] } }))
  await approval.getByRole('button', { name: '允许', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).at(-1)?.status)).toBe('error')
  expect(turns()).toHaveLength(2)
  const completed = await page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).at(-1)!)
  expect(completed.error).toContain('AI 权限')
  expect(completed.citations ?? []).toEqual([])
  await page.evaluate(() => window.jiwei.settings.set({ browser: { aiBlockedSites: [] }, retrieval: { cautious: false } }))
  fixture.steps = [{ text: '恢复权限后的新回答' }]
  await newChat()
  expect((await ask('权限恢复后继续提问')).assistant.content).toContain('恢复权限后的新回答')
})

test('26. 搜索等待期间改为不给AI会取消请求，保密查询不会回退到下一服务', async () => {
  const query = '银杉抽屉中的特别秘密编号'
  const noteId = await createNote('受控等待期隐私记录', [query + '仅供本地测试，不得继续发送。'])
  await newChat()
  fixture.steps = [{ name: 'web_search', args: { query } }]
  fixture.failures.set('bocha', 500)
  const paused = fixture.pauseNext((request) => request.path === '/search/bocha' && request.query === query)
  try {
    await startAsk('搜一下受控等待期的资料')
    await paused.reached
    expect(
      searchRequests()
        .filter((request) => request.query === query)
        .map((request) => request.path)
    ).toEqual(['/search/bocha'])
    await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true }), noteId)
    paused.release()
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).length)).toBe(1)
    const completed = await page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).at(-1)!)
    expect(completed.steps?.find((step) => step.tool === 'web_search')).toMatchObject({ status: 'error' })
    expect(completed.steps?.find((step) => step.tool === 'web_search')?.detail).toContain('已拦截')
    expect(
      searchRequests()
        .filter((request) => request.query === query)
        .map((request) => request.path)
    ).toEqual(['/search/bocha'])
    expect(await page.evaluate((id) => window.jiwei.notes.get(id), noteId)).toMatchObject({ aiExcluded: true })
  } finally {
    paused.release()
  }
})

test('27. DeepSeek 独立 Key、连接测试和首选服务重载后保留，清除后停用', async () => {
  test.setTimeout(60_000)
  fixture.deepseekExpectedKey = 'controlled-deepseek-own-key'
  await settings()
  await page.getByTestId('backend-deepseek-expand').click()
  const key = page.getByTestId('backend-deepseek-key')
  await key.fill('controlled-deepseek-own-key')
  await page.getByTestId('backend-deepseek-save').click()
  await expect(key).toHaveValue('')
  await expect(page.getByTestId('backend-deepseek-toggle')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('backend-deepseek-test').click()
  await expect(page.getByTestId('backend-deepseek-result')).toContainText('连接成功')
  expect(searchRequests().at(-1)?.body).toEqual({ query: 'learning', count: 1, need_content: false })
  await page.getByTestId('retrieval-prefer-zh').selectOption('deepseek')
  await page.getByTestId('retrieval-prefer-en').selectOption('deepseek')
  await closeSettings()
  await page.reload()
  await page.waitForSelector('nav')
  await settings()
  await expect(page.getByTestId('retrieval-prefer-zh')).toHaveValue('deepseek')
  await expect(page.getByTestId('retrieval-prefer-en')).toHaveValue('deepseek')
  await page.getByTestId('backend-deepseek-expand').click()
  await expect(page.getByTestId('backend-deepseek-key')).toHaveAttribute('placeholder', '已设置')
  await page.getByTestId('backend-deepseek-clear').click()
  await expect(page.getByTestId('backend-deepseek-toggle')).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.retrieval.status())).backends.find((s) => s.id === 'deepseek')?.keySet)
    .toBe(false)
  await closeSettings()
})

test('28. DeepSeek 复用官方 Key 完成搜索、原文引用与快照，撤销 Key 后界面立即失效', async ({ browserName: _browserName }, info) => {
  test.setTimeout(90_000)
  fixture.deepseekExpectedKey = 'controlled-deepseek-provider-key'
  await page.evaluate(async () => {
    for (const id of ['bocha', 'tavily'] as const) await window.jiwei.retrieval.saveBackend({ id, enabled: false })
  })
  await settings()
  await page.getByTestId('backend-deepseek-expand').click()
  await expect(page.getByRole('radio', { name: '使用模型服务「受控第三方 DeepSeek Key」的 Key', exact: true })).toHaveCount(0)
  await page.getByRole('radio', { name: '使用模型服务「受控官方 DeepSeek Key」的 Key', exact: true }).check()
  await page.getByTestId('backend-deepseek-save').click()
  await expect(page.getByTestId('backend-deepseek-toggle')).toHaveAttribute('aria-checked', 'true')
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.retrieval.status())).backends.find((s) => s.id === 'deepseek')?.keyProviderId)
    .toBe(deepseekProviderId)
  expect(await dbRows('SELECT key_enc FROM search_backends WHERE id=?', ['deepseek'])).toEqual([{ key_enc: null }])
  await page.getByTestId('retrieval-prefer-zh').selectOption('deepseek')
  await closeSettings()
  // 已被旧用例引用的快照会被正确保留；用独立网页验证这次确实执行原文读取。
  const originalUrl = fixture.base + '/page-deepseek-original'
  fixture.searchResults = [{ url: originalUrl, title: 'DeepSeek 受控原文', snippet: '公开原文的短摘要。' }]
  fixture.steps = [
    { name: 'web_search', args: { query: '公开资料提取练习' } },
    { name: 'read_url', args: { url: originalUrl } }
  ]
  const completed = await ask('请根据资料说明间隔重复的稳定原理')
  expect(searchRequests().map((r) => r.path)).toEqual(['/search/deepseek'])
  expect(searchRequests()[0].body).toEqual({ query: '公开资料提取练习', count: 6, need_content: false })
  expect(toolsText()).toContain('受控长摘要：公开原文说明升级步骤和兼容性。')
  expect(fixture.requests.some((r) => r.path === '/page-deepseek-original')).toBe(true)
  const cited = completed.assistant.citations!.find((c) => c.parentType === 'web')!
  expect(cited.parentId).toBeTruthy()
  expect(cited.snippetOnly).not.toBe(true)
  await expect(webChips()).toHaveCount(1)
  await webChips().click()
  await expect(page.getByTestId('web-snapshot-body')).toContainText('公开测试版本九的发布说明')
  await shot(info, 'deepseek-read-citation')
  await page.keyboard.press('Escape')
  await page.evaluate((id) => window.jiwei.providers.save({ id, kind: 'deepseek', apiKey: '' }), deepseekProviderId)
  await expect.poll(() => page.evaluate(() => window.jiwei.retrieval.status().then((s) => s.webAvailable))).toBe(false)
  await settings()
  await expect(page.getByTestId('backend-deepseek-toggle')).toBeDisabled()
  await closeSettings()
  const status = await page.evaluate(() => window.jiwei.retrieval.status())
  expect(JSON.stringify(status)).not.toContain('controlled-deepseek-provider-key')
  expect(status.backends.find((s) => s.id === 'deepseek')).toMatchObject({ keySet: false, keyProviderId: deepseekProviderId })
})

async function cloudSetup(tools = false): Promise<void> {
  await page.evaluate(
    async ({ providerId, backends, tools }) => {
      for (const id of backends) await window.jiwei.retrieval.saveBackend({ id, enabled: false })
      await window.jiwei.retrieval.saveBackend({ id: 'deepseek', keyProviderId: null, key: 'controlled-fetch-key', enabled: false })
      await window.jiwei.providers.save({ id: providerId, kind: 'ollama', modelCaps: { 'deepseek-flash': { tools } } })
      await window.jiwei.settings.set({ retrieval: { academic: false } })
    },
    { providerId, backends: [...WEB_BACKENDS], tools }
  )
  fixture.deepseekExpectedKey = 'controlled-fetch-key'
}
const cloudRequests = () => fixture.requests.filter((request) => request.path === '/search/deepseek/fetch')

test('29. 本地失败后手动云端代读、精确引用、资料隔离和重启来源保留', async ({ browserName: _browserName }, info) => {
  test.setTimeout(90_000)
  await cloudSetup()
  const url = fixture.base + '/page-cloud-journey'
  const local = await page.evaluate((url) => window.jiwei.sources.addUrl(url, '原本地资料'), url)
  await expect.poll(async () => (await dbRows('SELECT asset_id FROM sources WHERE id=?', [local.id]))[0]?.asset_id).toBeTruthy()
  const oldLocal = await dbRows('SELECT asset_id,title,web_origin FROM sources WHERE id=?', [local.id])
  fixture.emptyPages.add('/page-cloud-journey')
  await settings()
  const switcher = page.getByTestId('retrieval-cloud-reader')
  await expect(switcher).toHaveAttribute('aria-checked', 'false')
  await switcher.click()
  await expect(switcher).toHaveAttribute('aria-checked', 'true')
  await closeSettings()
  fixture.requests.length = 0
  const failed = await ask('请阅读这个网址：' + url)
  expect(searchRequests()).toEqual([])
  expect(failed.assistant.citations!.filter((c) => c.parentType === 'web')).toEqual([])
  const choice = page.getByTestId('cloud-read-option')
  await expect(choice).toContainText(url)
  await choice.getByRole('button', { name: '用 DeepSeek 读取此网页', exact: true }).click()
  await expect(choice).toContainText('积微无法检查其内部跳转')
  expect(cloudRequests()).toEqual([])
  await choice.getByRole('button', { name: '取消', exact: true }).click()
  expect(cloudRequests()).toEqual([])
  await choice.getByRole('button', { name: '用 DeepSeek 读取此网页', exact: true }).click()
  turnStartedAt = Date.now()
  await choice.getByRole('button', { name: '确认发送这个网址', exact: true }).click()
  const completed = await done(failed.id)
  expect(cloudRequests().map((request) => request.body)).toEqual([{ url }])
  expect(searchRequests()).toHaveLength(1)
  const cited = completed.assistant.citations!.find((c) => c.parentType === 'web')!
  expect(cited.webOrigin).toEqual({ provider: 'deepseek', urlVerified: false, truncated: false })
  expect(fixture.models.at(-1)?.user).toContain('不能据此声称官网已确认')
  await expect(page.getByTestId('cloud-answer-origin')).toContainText('最终来源未核验')
  expect(await dbRows('SELECT final_url,provider FROM web_pages WHERE id=?', [cited.parentId])).toEqual([
    { final_url: null, provider: 'deepseek' }
  ])
  // 尚未存为资料时，下一轮不得自动恢复旧云端正文。
  fixture.models.length = 0
  await ask('继续解释稳定学习原理，不读取网页')
  expect(fixture.models.at(-1)?.user).not.toContain('云端测试专属事实')
  await webChips().last().click()
  const snapshot = page.getByTestId('web-snapshot')
  await expect(snapshot).toContainText('DeepSeek 云端读取 · 最终来源未核验')
  await expect(snapshot).toContainText('请求网址')
  await expect(page.getByTestId('web-snapshot-open-original')).toHaveText('打开请求网址')
  await expect(page.locator('[data-highlighted="true"]').first()).toContainText('云端测试专属事实')
  await page.getByTestId('web-snapshot-save').click()
  await expect(page.getByText('已存入资料库', { exact: true })).toBeVisible()
  const all = await page.evaluate(() => window.jiwei.sources.list({}))
  const saved = all.find((s) => s.url === url && s.webOrigin?.provider === 'deepseek')!
  expect(saved.id).not.toBe(local.id)
  expect(await dbRows('SELECT asset_id,title,web_origin FROM sources WHERE id=?', [local.id])).toEqual(oldLocal)
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), saved.id)).length).toBeGreaterThan(0)
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.jiwei.knowledge.search('云端测试专属事实', { type: 'all' }, 8))).some(
        (hit) => hit.parentId === saved.id && hit.webOrigin?.urlVerified === false
      )
    )
    .toBe(true)
  await shot(info, 'cloud-read-source-isolation')
  await app.close()
  await launch()
  expect(await page.evaluate((id) => window.jiwei.sources.get(id), saved.id)).toMatchObject({ webOrigin: cited.webOrigin })
  await navTo(page, /资料库/)
  await page.getByText('云端专属代读文章', { exact: true }).click()
  await expect(page.getByTestId('source-web-origin').last()).toContainText('最终来源未核验')
})

test('30. 普通本地网址无搜索也能读取，未选择、关闭、否定和代码均零云端请求', async () => {
  await cloudSetup()
  const url = fixture.base + '/page-local-only'
  const local = await ask('请阅读 ' + url)
  expect(local.assistant.citations!.some((c) => c.parentType === 'web' && !c.webOrigin)).toBe(true)
  expect(searchRequests()).toEqual([])
  await retrieval({ cloudReader: true })
  await newChat()
  await ask('DeepSeek 是什么？请本地阅读 ' + url)
  await newChat()
  await ask('不要用 DeepSeek 读取 ' + url)
  await newChat()
  await ask('示例代码：`用 DeepSeek 读取 ' + url + '`')
  expect(cloudRequests()).toEqual([])
  await newChat()
  await mode('off')
  await ask('用 DeepSeek 读取这个公开网址：' + url)
  expect(cloudRequests()).toEqual([])
})

for (const revoke of ['setting', 'key', 'privacy'] as const) {
  test(`31. 云端正文进入首轮后撤销 ${revoke}，实际后续模型请求停止`, async () => {
    await cloudSetup(true)
    await page.evaluate(() => window.jiwei.retrieval.saveBackend({ id: 'bocha', enabled: true }))
    await retrieval({ cloudReader: true, cautious: true })
    const url = fixture.base + '/page-cloud-revoke-' + revoke
    const question = '用 DeepSeek 读取这个公开网址：' + url
    fixture.steps = [{ name: 'web_search', args: { query: '公开状态检查' } }, { text: '不应继续使用失效云端正文' }]
    await startAsk(question)
    const approval = page.getByTestId('approval-card')
    await expect(approval).toContainText(url)
    expect(cloudRequests()).toEqual([])
    await approval.getByRole('button', { name: '允许', exact: true }).click()
    await expect(approval).toContainText('公开状态检查')
    expect(cloudRequests()).toHaveLength(1)
    const turns = () => fixture.models.filter((request) => request.user.includes(question))
    expect(turns()).toHaveLength(1)
    expect(turns()[0].user).toContain('云端测试专属事实')
    if (revoke === 'setting') await retrieval({ cloudReader: false })
    else if (revoke === 'key') await page.evaluate(() => window.jiwei.retrieval.saveBackend({ id: 'deepseek', key: '', enabled: false }))
    else await page.evaluate(() => window.jiwei.settings.set({ browser: { aiBlockedSites: ['unrelated.example'] } }))
    await approval.getByRole('button', { name: '允许', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).at(-1)?.status)).toBe('error')
    expect(turns()).toHaveLength(1)
    const finished = await page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).at(-1)!)
    expect(finished.error).toContain('AI 权限')
    expect(finished.citations).toEqual([])
  })
}

test('32. 谨慎拒绝、令牌网址及已知站点拒绝不能触发云端', async () => {
  await cloudSetup()
  await retrieval({ cloudReader: true, cautious: true })
  const url = fixture.base + '/page-cloud-deny'
  await startAsk('用 DeepSeek 读取这个公开网址：' + url)
  const approval = page.getByTestId('approval-card')
  await expect(approval).toContainText(url)
  await approval.getByRole('button', { name: '拒绝', exact: true }).click()
  await done()
  expect(cloudRequests()).toEqual([])
  await retrieval({ cautious: false })
  await newChat()
  await ask('用 DeepSeek 读取这个公开网址：' + url + '?access_token=controlled-private')
  expect(cloudRequests()).toEqual([])
  await page.evaluate(() => window.jiwei.settings.set({ browser: { aiBlockedSites: ['127.0.0.1'] } }))
  await newChat()
  await ask('用 DeepSeek 读取这个公开网址：' + url)
  expect(cloudRequests()).toEqual([])
  await expect(page.getByTestId('cloud-read-option')).toHaveCount(0)
})

test('33. 无痕云端截断正文不落库，取消等待响应后不进入模型', async () => {
  await cloudSetup()
  await retrieval({ cloudReader: true })
  await page.getByRole('switch', { name: '无痕', exact: true }).click()
  fixture.cloudText = '云端超长专属正文。'.repeat(8000)
  const url = fixture.base + '/page-cloud-incognito'
  const finished = await ask('用 DeepSeek 读取这个公开网址：' + url)
  expect(finished.assistant.citations![0].webOrigin?.truncated).toBe(true)
  expect(finished.assistant.citations![0].parentId).toMatch(/^tmp-/)
  expect(await dbRows('SELECT id FROM web_pages WHERE url=?', [url])).toEqual([])
  await expect(page.getByTestId('cloud-answer-origin')).toContainText('已读取部分正文')
  await newChat()
  const paused = fixture.pauseNext((request) => request.path === '/search/deepseek/fetch')
  try {
    const before = fixture.models.length
    await startAsk('用 DeepSeek 读取这个公开网址：' + fixture.base + '/page-cloud-cancel')
    await paused.reached
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    paused.release()
    await expect
      .poll(() => page.evaluate(() => (Reflect.get(window, 'webChatCompletions') as ChatMessage[]).at(-1)?.status))
      .toBe('stopped')
    expect(fixture.models).toHaveLength(before)
    expect(await dbRows('SELECT id FROM web_pages WHERE url=?', [fixture.base + '/page-cloud-cancel'])).toEqual([])
  } finally {
    paused.release()
  }
})

test('34. 模型漏写引用编号时仍显示云端来源状态', async () => {
  await cloudSetup(true)
  await retrieval({ cloudReader: true })
  fixture.steps = [{ text: '根据返回的文本，升级前需要保存配置。' }]
  const finished = await ask('用 DeepSeek 读取这个公开网址：' + fixture.base + '/page-cloud-no-citation')
  expect(finished.assistant.citations).toEqual([])
  await expect(page.getByTestId('cloud-answer-origin')).toContainText('最终来源未核验')
})

test('35. 一次单页选择在云端失败后也不能由模型自动重试', async () => {
  await cloudSetup(true)
  await retrieval({ cloudReader: true })
  const url = fixture.base + '/page-cloud-failed-once'
  fixture.failures.set('deepseek-fetch', 500)
  fixture.steps = [
    { name: 'read_url', args: { url } },
    { name: 'read_url', args: { url } }
  ]
  await ask('用 DeepSeek 读取这个公开网址：' + url)
  expect(cloudRequests()).toHaveLength(1)
})

test('36. 中英文否定及转述文字不能把网址发送给云端', async () => {
  await cloudSetup()
  await retrieval({ cloudReader: true })
  const url = fixture.base + '/page-cloud-negative'
  for (const text of [
    '不使用 DeepSeek 读取 ',
    '禁止用 DeepSeek 总结 ',
    'Never use DeepSeek to summarize ',
    'Do not use cloud to explain ',
    '请解释这句话是什么意思：用 DeepSeek 读取 ',
    'The page says: use DeepSeek to read '
  ]) {
    await newChat()
    await ask(text + url)
    expect(cloudRequests()).toEqual([])
  }
})

test('37. 网址已预读后模型拒绝工具，复用证据无工具回答且不搜索', async () => {
  fixture.unsupportedOnce = true
  const url = fixture.base + '/page-pre-read-unsupported'
  const completed = await ask('请阅读最新说明：' + url)
  expect(fixture.models).toHaveLength(2)
  expect(fixture.models[0].tools).toContain('read_url')
  expect(fixture.models[1].tools).toEqual([])
  expect(fixture.models[1].user).toContain('公开测试版本九')
  expect(completed.assistant.citations!.some((c) => c.url === url)).toBe(true)
  expect(searchRequests()).toEqual([])
  expect(fixture.requests.filter((r) => r.path === '/page-pre-read-unsupported')).toHaveLength(1)
})

test('38. 两个长网址的比较在首次实际模型消息中都提供正文', async () => {
  await cloudSetup()
  fixture.pageTexts.set('/page-comparison-one', '第一个网址独有事实：方案甲的成本为十二，优势是部署简单。'.repeat(100))
  fixture.pageTexts.set('/page-comparison-two', '第二个网址独有事实：方案乙的成本为九，优势是维护方便。'.repeat(100))
  await ask('请比较这两个网址：' + fixture.base + '/page-comparison-one ' + fixture.base + '/page-comparison-two')
  expect(fixture.models[0].user).toContain('第一个网址独有事实')
  expect(fixture.models[0].user).toContain('第二个网址独有事实')
  expect(searchRequests()).toEqual([])
})

test('39. 公开网页503失败提供手动补充，未点击时云端零请求', async () => {
  await cloudSetup()
  await retrieval({ cloudReader: true })
  fixture.failures.set('/page-cloud-server-error', 503)
  await ask('请阅读 ' + fixture.base + '/page-cloud-server-error')
  await expect(page.getByTestId('cloud-read-option')).toBeVisible()
  expect(cloudRequests()).toEqual([])
})

test('40. 公开JS网页真实渲染超时后提供手动补充', async () => {
  await cloudSetup()
  await retrieval({ cloudReader: true })
  const path = '/page-cloud-render-timeout'
  fixture.emptyPages.add(path)
  const paused = fixture.pauseNext((request) => request.path === path && fixture.requests.filter((r) => r.path === path).length >= 2)
  try {
    await startAsk('请阅读 ' + fixture.base + path)
    await paused.reached
    await done()
    await expect(page.getByTestId('cloud-read-option')).toBeVisible()
    expect(cloudRequests()).toEqual([])
  } finally {
    paused.release()
  }
})
