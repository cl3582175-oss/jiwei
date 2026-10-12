import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { createServer, type Server } from 'http'
import JSZip from 'jszip'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server, root: string, source: string, userData: string, harness: string
let workId: string, decisionId: string, taskId: string
const prompts: { system: string; prompt: string }[] = []
const shots = process.env.SHOTS_DIR
const longCriterion = '证据完整性与长期可核查性的综合评价'.repeat(4)
function file(path: string, value: string | object) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}
function fixture(version = '1', risky = false) {
  file(join(source, '.claude-plugin/plugin.json'), {
    name: 'b2-fixture',
    displayName: '自编产品插件',
    version,
    description: risky ? '长描述需要完整查看。'.repeat(799) + '描述结尾' : 'Self-authored integration evidence',
    author: { name: risky ? '合法长作者名'.repeat(1000) + '作者结尾' : 'Jiwei test fixture' },
    ...(risky
      ? {
          userConfig: { token: { type: 'string', title: '合成凭证', description: 'Synthetic test only', sensitive: true, required: true } },
          mcpServers: { 'fixture-connector': { command: 'fixture-never-run', args: [], env: { KEY: '${user_config.token}' } } }
        }
      : {})
  })
  file(join(source, 'skills/read/SKILL.md'), '---\nname: read\ndescription: Self-authored reader\n---\nRead the selected evidence.')
  file(join(source, 'skills/read/never.sh'), 'touch SHOULD_NEVER_EXIST')
  file(join(source, 'commands/check.md'), '---\ndescription: Self-authored command\n---\nCheck $ARGUMENTS')
  file(
    join(source, 'jiwei/lenses/evidence/SKILL.md'),
    '---\nname: evidence\ndescription: Evidence lens\nmetadata:\n  kind: lens\n  title: 自编证据视角\n  output: items\n  landing: append\n  instruction: 提取可核查的事实和仍待确认的问题。\n---\nExtract verifiable facts.'
  )
  file(join(source, 'jiwei/templates/article.json'), {
    id: 'article',
    type: 'article',
    title: { zh: '证据文章模板', en: 'Evidence article' },
    description: { zh: '先证据再结论', en: 'Evidence before conclusions' },
    audience: '初学者',
    mode: 'coach',
    outline: ['证据清单', '结论与局限'],
    guidance: 'TEMPLATE_DATA_ONLY: distinguish facts and assumptions.'
  })
  file(join(source, 'jiwei/frameworks/decision.json'), {
    id: 'decision',
    title: { zh: '证据决策框架', en: 'Evidence decision' },
    description: { zh: '核对事实和代价', en: 'Check facts and costs' },
    criteria: [
      { name: longCriterion, weight: 5, hint: 'FRAMEWORK_DATA_ONLY: verify the evidence' },
      { name: '成本', weight: 2, hint: 'Estimate cost' }
    ],
    questions: ['还缺什么证据？']
  })
  file(join(source, 'jiwei/recipes/review.json'), {
    id: 'review',
    name: { zh: '证据回顾任务', en: 'Evidence review' },
    instructionEn: 'Review the available evidence',
    task: {
      name: '证据回顾任务',
      instruction: '复核证据并区分事实与推断。',
      trigger: { type: 'manual' },
      tools: ['knowledge_search'],
      outputs: { inbox: true }
    }
  })
  file(join(source, 'jiwei/sources.json'), {
    feeds: [
      { url: `http://127.0.0.1:${(server?.address() as { port: number } | null)?.port ?? 1}/feed.xml`, title: '自编信息源', kind: 'rss' },
      {
        url: `http://127.0.0.1:${(server?.address() as { port: number } | null)?.port ?? 1}/unselected.xml`,
        title: '不添加的信息源',
        kind: 'rss'
      }
    ]
  })
}
async function start() {
  const env = {
    ...process.env,
    JIWEI_LANG: 'zh-CN',
    JIWEI_SKIP_ONBOARDING: '1',
    JIWEI_TEST_NETWORK: '1',
    JIWEI_IMPORT_PROVIDERS_FROM: '',
    JIWEI_TEST_PLUGINS: ''
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [harness, `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900))
}
async function settings(tab = '插件') {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: tab, exact: true }).click()
}
async function picker(path: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
}
async function shot(name: string) {
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, name + '.png') })
  }
}
function pluginCard() {
  return page.locator('[data-plugin-id="b2-fixture@local"]')
}
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jiwei-b2-e2e-'))
  userData = join(root, 'user-data')
  const appData = join(root, 'app-data')
  mkdirSync(userData)
  mkdirSync(appData)
  source = join(root, 'source')
  fixture()
  harness = join(root, 'main.cjs')
  file(
    harness,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.setPath('appData',${JSON.stringify(appData)});app.getAppPath=()=>${JSON.stringify(process.cwd())};require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});`
  )
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      res
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          '<rss version="2.0"><channel><title>Self authored feed</title><link>https://example.org</link><description>Controlled</description></channel></rss>'
        )
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body),
        text = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => x.text ?? '').join('') : '')
      const system = text(input.messages.find((m: { role: string }) => m.role === 'system')?.content),
        prompt = text(input.messages.filter((m: { role: string }) => m.role === 'user').at(-1)?.content)
      prompts.push({ system, prompt })
      const reply = system.includes('参谋')
        ? {
            restated: '核对证据再做选择',
            options: [
              { id: 'O1', title: '选择一', summary: '路径一' },
              { id: 'O2', title: '选择二', summary: '路径二' }
            ],
            criteria: [
              { name: longCriterion, weight: 5, why: '受控' },
              { name: '成本', weight: 2, why: '受控' }
            ],
            scores: [],
            evidence: [],
            assumptions: [],
            premortem: [],
            secondOrder: [],
            counter: '',
            risks: [],
            recommendation: { option: 'O1', why: '受控结果' },
            confidence: 2,
            unknowns: []
          }
        : system.includes('写作教练')
          ? { questions: ['请指出支持结论的证据'], tips: ['区分事实与推断'] }
          : {
              sections: [
                { title: '证据清单', points: ['事实'], sources: [] },
                { title: '结论与局限', points: ['不确定性'], sources: [] }
              ]
            }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'controlled',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify(reply) } }]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 500, completion_tokens: 300, total_tokens: 800 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  fixture()
  await start()
  await page.evaluate(
    async (baseUrl) => {
      const j = window.jiwei,
        p = await j.providers.save({ kind: 'ollama', name: '受控自编插件模型', baseUrl, models: ['deepseek-flash'] } as never),
        s = await j.settings.get()
      await j.settings.set({
        theme: 'light',
        tasks: { paused: true },
        ai: { ...s.ai, chat: { providerId: p.id, model: 'deepseek-flash' }, effort: 'off' }
      } as never)
    },
    `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  )
})
test.afterAll(async () => {
  await app?.close()
  if (server) await new Promise<void>((r) => server.close(() => r()))
  if (root) rmSync(root, { recursive: true, force: true })
})
test('folder picker -> real preview token -> confirmation, cancellation and actual content lists', async () => {
  await settings()
  await picker(source)
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toContainText('这个插件不是积微官方提供的')
  await expect(confirm.getByRole('button', { name: '安装', exact: true })).toBeFocused()
  await shot('b2-confirm-light')
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  expect(await page.evaluate(() => window.jiwei.plugins.list())).toHaveLength(0)
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  await expect(confirm).toBeVisible()
  await confirm.getByLabel('不添加的信息源').uncheck()
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(pluginCard()).toContainText('已启用')
  const data = await page.evaluate(async () => ({
    skills: await window.jiwei.skills.list(),
    lenses: await window.jiwei.lenses.list(),
    feeds: await window.jiwei.discover.feeds(),
    recipes: await window.jiwei.tasks.recipes()
  }))
  expect(data.skills.some((x) => x.name === 'b2-fixture:read' && x.pluginId === 'b2-fixture@local')).toBe(true)
  expect(data.skills.some((x) => x.name === 'b2-fixture:check')).toBe(true)
  expect(data.lenses.some((x) => x.id === 'b2-fixture:evidence')).toBe(true)
  expect(data.feeds.map((x) => x.title)).toEqual(['自编信息源'])
  expect(data.recipes.some((x) => x.id === 'b2-fixture:review')).toBe(true)
  await page.getByRole('button', { name: '技能', exact: true }).click()
  await expect(page.getByText('b2-fixture:read', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'b2-fixture', exact: true }).first().click()
  await expect(pluginCard()).toBeVisible()
  await page.getByRole('button', { name: '视角', exact: true }).click()
  const lens = page.getByTestId('lens-settings').locator('article').filter({ hasText: '自编证据视角' })
  await expect(lens).toBeVisible()
  await expect(lens.getByRole('button', { name: /编辑|删除|移除/ })).toHaveCount(0)
  await lens.getByRole('button', { name: 'b2-fixture', exact: true }).click()
  await expect(pluginCard()).toBeVisible()
  await page.keyboard.press('Escape')
})
test('selected template and framework persist and reach real main model inputs; recipe saves provenance', async () => {
  await navTo(page, /^作品/)
  await page.getByRole('button', { name: /图文长文/ }).click()
  const dialog = page.getByTestId('new-work-dialog')
  await dialog.getByLabel('作品模板').selectOption('b2-fixture:article')
  await expect(dialog.getByLabel('选题')).toHaveValue('证据文章模板')
  await expect(dialog.getByLabel('写给谁')).toHaveValue('初学者')
  await shot('b2-template-selected')
  await dialog.getByRole('button', { name: '开始创作' }).click()
  const w = (await page.evaluate(() => window.jiwei.works.list()))[0]
  workId = w.id
  expect(w).toMatchObject({ title: '证据文章模板', audience: '初学者', mode: 'coach' })
  expect(w.content?.parts.map((x) => x.title)).toEqual(['证据清单', '结论与局限'])
  expect(w.template?.id).toBe('b2-fixture:article')
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: '重新生成结构', exact: true }).click()
  await expect(page.getByTestId('work-outline').locator('[data-part]')).toHaveCount(2)
  await expect.poll(() => prompts.filter((x) => x.prompt.includes('TEMPLATE_DATA_ONLY')).length).toBeGreaterThan(0)
  expect(prompts.find((x) => x.prompt.includes('TEMPLATE_DATA_ONLY'))!.system).not.toContain('TEMPLATE_DATA_ONLY')
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.getByRole('button', { name: '为每一节生成提示问题', exact: true }).click()
  await expect(page.getByTestId('work-sections')).toContainText('请指出支持结论的证据')
  await navTo(page, /^参谋/)
  await page.getByLabel('用分析框架').selectOption('b2-fixture:decision')
  await page.getByLabel('参谋', { exact: true }).fill('该选择证据充分的方案还是成本低的方案？')
  await shot('b2-framework-selected')
  await page.getByRole('button', { name: '请参谋', exact: true }).click()
  await expect(page.getByTestId('decision-memo')).toBeVisible()
  const d = (await page.evaluate(() => window.jiwei.advisor.list()))[0]
  decisionId = d.id
  expect(d.framework?.criteria[0].weight).toBe(5)
  expect(d.memo?.criteria[0].name).toBe(longCriterion)
  await page.evaluate(
    async ({ id, name }) => {
      await window.jiwei.advisor.weights(id, { [name]: 3, 成本: 4 })
    },
    { id: d.id, name: longCriterion }
  )
  expect((await page.evaluate((id) => window.jiwei.advisor.get(id), d.id)).weights).toEqual({ [longCriterion]: 3, 成本: 4 })
  const call = prompts.find((x) => x.prompt.includes('FRAMEWORK_DATA_ONLY'))!
  expect(call.prompt).toContain('还缺什么证据')
  expect(call.system).not.toContain('FRAMEWORK_DATA_ONLY')
  expect(call.prompt).toContain('<external-data')
  await settings('AI 任务')
  await page.getByRole('button', { name: '证据回顾任务', exact: true }).click()
  await expect(page.getByLabel('任务名称')).toHaveValue('证据回顾任务')
  await shot('b2-recipe-selected')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const task = (await page.evaluate(() => window.jiwei.tasks.list()))[0]
  taskId = task.id
  expect(task.pluginId).toBe('b2-fixture@local')
  expect(task.recipe).toBe('b2-fixture:review')
  await page.keyboard.press('Escape')
})
test('capability update needs high-risk confirmation, safe focus, presence-only config, rollback', async () => {
  fixture('2', true)
  await settings()
  await pluginCard().getByRole('button', { name: '检查文件更新' }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await expect(confirm).toContainText('新增能力')
  await expect(confirm).toContainText('MCP 服务器: fixture-connector')
  await expect(confirm).toContainText('运行程序: fixture-never-run')
  await expect(confirm).toContainText('需要提供: 合成凭证')
  await expect(confirm).not.toContainText('servers:')
  await expect(confirm).not.toContainText('sensitive:')
  await expect(confirm).toContainText('fixture-never-run')
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'dark' }))
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
  await shot('b2-confirm-dark')
  await page.evaluate(() => window.jiwei.settings.set({ language: 'en' }))
  await expect(confirm).toContainText('Run programs: fixture-never-run')
  await expect(confirm).toContainText('Requires: 合成凭证')
  await shot('b2-confirm-english')
  await page.evaluate(() => window.jiwei.settings.set({ language: 'zh-CN' }))
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(640, 640)
    win.setSize(760, 760)
  })
  const footerBox = await confirm.locator('footer').boundingBox()
  const dialogBox = await confirm.boundingBox()
  expect(footerBox!.y + footerBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height)
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
  await expect(confirm.getByRole('button', { name: '更新并同意新的能力' })).toBeInViewport()
  await expect(confirm.getByText('运行程序: fixture-never-run', { exact: true })).toBeInViewport()
  const scroll = confirm.locator('div.overflow-y-auto').first()
  expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await expect(confirm).toContainText('描述结尾')
  await expect(confirm).toContainText('作者结尾')
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
  await scroll.evaluate((el) => {
    el.scrollTop = 0
  })
  await shot('b2-confirm-narrow')
  expect(await confirm.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.keyboard.press('Enter')
  await expect(confirm).toHaveCount(0)
  expect((await page.evaluate(() => window.jiwei.plugins.list()))[0].version).toBe('1')
  await pluginCard().getByRole('button', { name: '检查文件更新' }).click()
  await confirm.getByLabel('合成凭证').fill('synthetic-b2-test-only')
  await expect(confirm.getByLabel('合成凭证')).toHaveAttribute('type', 'password')
  await confirm.getByRole('button', { name: '更新并同意新的能力' }).click()
  await expect(pluginCard()).toContainText('2')
  const p = (await page.evaluate(() => window.jiwei.plugins.list()))[0]
  expect(p.sensitive.token).toBe(true)
  expect(JSON.stringify(p)).not.toContain('synthetic-b2-test-only')
  expect((await page.evaluate(() => window.jiwei.mcp.servers()))[0].enabled).toBe(false)
  await pluginCard().locator('summary').click()
  await expect(pluginCard()).toContainText('已设置')
  await expect(pluginCard().getByLabel('合成凭证')).toHaveValue('')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  const connector = page.getByTestId('mcp-server').filter({ hasText: 'fixture-connector' })
  await expect(connector).toBeVisible()
  await expect(connector.getByRole('switch')).not.toBeChecked()
  await expect(connector.getByRole('button', { name: '修改', exact: true })).toBeDisabled()
  await expect(connector.getByRole('button', { name: '删除', exact: true })).toBeDisabled()
  await connector.getByRole('button', { name: 'b2-fixture', exact: true }).click()
  await expect(pluginCard()).toBeVisible()
  await pluginCard().getByRole('button', { name: /回滚/ }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.plugins.list()))[0].version).toBe('1')
  expect(await page.evaluate(() => window.jiwei.mcp.servers())).toHaveLength(0)
  await page.keyboard.press('Escape')
  await app.close()
  await start()
})
test('actual restart keeps selections; disable hides definitions, uninstall retains user rows, zip picker installs', async () => {
  const saved = await page.evaluate(
    async ({ workId, decisionId, taskId }) => ({
      work: await window.jiwei.works.get(workId),
      decision: await window.jiwei.advisor.get(decisionId),
      task: (await window.jiwei.tasks.list()).find((t) => t.id === taskId)
    }),
    { workId, decisionId, taskId }
  )
  expect(saved.work.template?.id).toBe('b2-fixture:article')
  expect(saved.decision.framework?.id).toBe('b2-fixture:decision')
  expect(saved.task?.pluginId).toBe('b2-fixture@local')
  await settings()
  await pluginCard().getByRole('button', { name: '停用', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.plugins.templates())).length).toBe(0)
  expect((await page.evaluate(() => window.jiwei.skills.list())).some((s) => s.pluginId === 'b2-fixture@local')).toBe(false)
  expect((await page.evaluate(() => window.jiwei.plugins.frameworks())).length).toBe(0)
  expect((await page.evaluate(() => window.jiwei.tasks.recipes())).some((r) => r.id === 'b2-fixture:review')).toBe(false)
  await pluginCard().getByRole('button', { name: '卸载', exact: true }).click()
  const uninstall = page.getByTestId('plugin-uninstall')
  await expect(uninstall.getByLabel('同时删除订阅源')).not.toBeChecked()
  await expect(uninstall.getByLabel('同时删除任务')).not.toBeChecked()
  await uninstall.getByRole('button', { name: '卸载', exact: true }).click()
  await expect(pluginCard()).toHaveCount(0)
  expect((await page.evaluate(() => window.jiwei.tasks.list()))[0].pluginId).toBeNull()
  expect((await page.evaluate(() => window.jiwei.discover.feeds()))[0].pluginId).toBeNull()
  expect(readdirSync(join(userData, 'plugins', 'data'))).toEqual([])
  expect(readdirSync(join(userData, 'plugins', 'cache'))).toEqual([])
  fixture('zip-1')
  const zip = new JSZip()
  for (const name of readdirSync(source, { recursive: true })) {
    const path = join(source, String(name))
    try {
      zip.file(String(name), readFileSync(path))
    } catch {
      /* directories have no payload */
    }
  }
  const archive = join(root, 'plugin.zip')
  writeFileSync(archive, await zip.generateAsync({ type: 'nodebuffer' }))
  await picker(archive)
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toBeVisible()
  for (const box of await confirm.getByRole('checkbox').all()) await box.uncheck()
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(pluginCard()).toContainText('zip-1')
  await shot('b2-installed-zip')
  await page.keyboard.press('Escape')
  await app.close()
  await start()
  expect((await page.evaluate(() => window.jiwei.plugins.list()))[0].version).toBe('zip-1')
  expect(existsSync(join(process.cwd(), 'SHOULD_NEVER_EXIST'))).toBe(false)
})

test('UI cancellation interrupts the real pre-commit install and corrupt zip reports an error', async () => {
  const cancelSource = join(root, 'cancel-source')
  file(join(cancelSource, '.claude-plugin/plugin.json'), { name: 'cancel-fixture', version: '1' })
  file(join(cancelSource, 'skills/read/SKILL.md'), '---\nname: read\ndescription: Cancellation fixture\n---\nRead only.')
  await settings()
  await picker(cancelSource)
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toBeVisible()
  // 只注入文件改名的等待点；实际安装、取消、清理仍走生产 handlers 与文件系统。
  await app.evaluate(() => {
    const fs = process.getBuiltinModule('fs/promises')
    const original = fs.rename
    const state = globalThis as typeof globalThis & { b2Release?: () => void; b2Reached?: boolean }
    const gate = new Promise<void>((resolve) => {
      state.b2Release = resolve
    })
    fs.rename = async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]).includes('/plugins/cache/')) {
        state.b2Reached = true
        await gate
        fs.rename = original
      }
      return original(...args)
    }
  })
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect.poll(() => app.evaluate(() => !!(globalThis as typeof globalThis & { b2Reached?: boolean }).b2Reached)).toBe(true)
  await expect(confirm.getByRole('status')).toContainText('安装中')
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  await app.evaluate(() => (globalThis as typeof globalThis & { b2Release?: () => void }).b2Release?.())
  await expect(confirm).toHaveCount(0)
  expect((await page.evaluate(() => window.jiwei.plugins.list())).some((p) => p.id === 'cancel-fixture@local')).toBe(false)
  const corrupt = join(root, 'corrupt.zip')
  file(corrupt, 'not a zip')
  await picker(corrupt)
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  await expect(page.getByTestId('plugin-acquisition').getByRole('alert')).toBeVisible()
  expect((await page.evaluate(() => window.jiwei.plugins.list())).map((p) => p.id)).toEqual(['b2-fixture@local'])
  expect(readdirSync(join(userData, 'plugins', 'previews'))).toEqual([])
  await shot('b2-corrupt-file-error')
})
