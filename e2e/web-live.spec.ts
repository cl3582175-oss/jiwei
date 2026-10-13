import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateEmbeddingCache } from './fixtures/embeddingCache'

// 联网的真实验收（Claude 审查用）：真实 DeepSeek + 真实学术接口 + 真实网页，不需要网页搜索 Key。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库路径> npx playwright test e2e/web-live.spec.ts
// 受控回归会忽略 *-live.spec.ts。API Key 以密文复制到临时目录，不解密、不输出。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let providerId = ''
const model = process.env.WEB_LIVE_MODEL ?? 'deepseek-flash'
const out = process.env.WEB_LIVE_OUT ?? join(tmpdir(), 'jiwei-web-live.json')
const report: Record<string, unknown>[] = []

type Msg = {
  id: string
  status: string
  content: string
  error: string | null
  steps: { tool: string; label: string; status: string; detail?: string }[]
  citations: { n: number; parentType: string; title: string; url?: string; snippetOnly?: boolean; meta?: { doi?: string } }[]
}

async function ask(
  name: string,
  text: string,
  opts: { web?: 'off' | 'auto' | 'always'; conversationId?: string } = {}
): Promise<Msg & { conversationId: string; ms: number }> {
  const t0 = Date.now()
  const r = await page.evaluate(
    ({ text, providerId, model, web, conversationId }) =>
      window.jiwei.chat.send({
        conversationId: conversationId ?? null,
        text,
        providerId,
        model,
        effort: 'off',
        scope: { type: 'all' },
        ...(web ? { web } : {})
      }),
    { text, providerId, model, web: opts.web, conversationId: opts.conversationId }
  )
  let m: Msg | undefined
  await expect
    .poll(
      async () => {
        const list = (await page.evaluate((id) => window.jiwei.chat.messages(id), r.conversation.id)) as Msg[]
        m = list.find((x) => x.id === r.assistantMessageId)
        return m?.status
      },
      { timeout: 240_000, intervals: [1000] }
    )
    .not.toBe('streaming')
  const ms = Date.now() - t0
  report.push({
    name,
    text,
    ms,
    status: m!.status,
    error: m!.error,
    steps: m!.steps.map((s) => `${s.status} ${s.tool} | ${s.label}${s.detail ? ' | ' + s.detail.slice(0, 120) : ''}`),
    citations: m!.citations.map(
      (c) => `[${c.n}] ${c.parentType}${c.snippetOnly ? '(摘要)' : ''} ${c.title.slice(0, 60)} ${c.url ?? ''} ${c.meta?.doi ?? ''}`
    ),
    content: m!.content
  })
  writeFileSync(out, JSON.stringify(report, null, 2))
  return { ...m!, conversationId: r.conversation.id, ms }
}
const tools = (m: Msg): string[] => m.steps.map((s) => s.tool)

test.beforeAll(async () => {
  test.setTimeout(300_000)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-web-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await isolateEmbeddingCache(app)
  const providers = await page.evaluate(() => window.jiwei.providers.list())
  providerId = providers.find((p) => p.kind === 'deepseek' && p.hasKey)!.id
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-web-live-src-'))
  writeFileSync(
    join(dir, '遗忘曲线.md'),
    '# 艾宾浩斯遗忘曲线\n\n学习后 20 分钟遗忘约 42%，一天后遗忘约 66%。\n\n## 间隔重复\n\n在快要遗忘的时候复习，记忆保持最久。'
  )
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '遗忘曲线.md'))
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.embedding.status())
        return s.total > 0 && s.indexed === s.total
      },
      { timeout: 180_000 }
    )
    .toBe(true)
  const status = await page.evaluate(() => window.jiwei.retrieval.status())
  expect(status.webAvailable).toBe(false)
  expect(status.academicEnabled).toBe(true)
})
test.afterAll(async () => {
  writeFileSync(out, JSON.stringify(report, null, 2))
  await app?.close()
})

test('S1 中文提问的学术检索', async () => {
  test.setTimeout(300_000)
  const m = await ask('S1', '最近两年关于检索增强生成（RAG）系统评测方法的代表性论文有哪些？请给出出处。')
  expect(m.status).toBe('done')
  expect.soft(tools(m)).toContain('web_search')
})

test('S2 英文学术检索', async () => {
  test.setTimeout(300_000)
  const m = await ask('S2', 'What are recent benchmark papers for evaluating deep research agents? Please cite sources.')
  expect(m.status).toBe('done')
  expect.soft(tools(m)).toContain('web_search')
})

test('S3 读用户给出的英文网页', async () => {
  test.setTimeout(300_000)
  const m = await ask('S3', '请读 https://en.wikipedia.org/wiki/Retrieval-augmented_generation ，用三点总结 RAG 的主要局限，并标注出处。')
  expect(m.status).toBe('done')
  expect.soft(tools(m)).toContain('read_url')
  expect.soft(m.citations.some((c) => c.parentType === 'web' && !c.snippetOnly)).toBe(true)
})

test('S4 读 arXiv PDF', async () => {
  test.setTimeout(300_000)
  const m = await ask('S4', '读一下 https://arxiv.org/pdf/2005.11401 这篇论文：它提出的方法叫什么？在哪些任务上做了评测？')
  expect(m.status).toBe('done')
  expect.soft(tools(m)).toContain('read_url')
})

test('S5 知识库与网页同时出现（冲突裁决）', async () => {
  test.setTimeout(300_000)
  const m = await ask(
    'S5',
    '我资料里说一天后会遗忘多少？再读读 https://en.wikipedia.org/wiki/Forgetting_curve 看看公开资料怎么说，两者一致吗？'
  )
  expect(m.status).toBe('done')
  expect.soft(m.citations.some((c) => c.parentType === 'source')).toBe(true)
  expect.soft(m.citations.some((c) => c.parentType === 'web')).toBe(true)
})

test('S6 知识库足够时不联网', async () => {
  test.setTimeout(300_000)
  const m = await ask('S6', '根据我的资料，学习后 20 分钟大约遗忘多少？')
  expect(m.status).toBe('done')
  expect.soft(tools(m)).not.toContain('web_search')
  expect.soft(tools(m)).not.toContain('read_url')
})

test('S7 需要最新信息但只能查学术文献', async () => {
  test.setTimeout(300_000)
  await ask('S7', 'DeepSeek 现在的 API 价格是多少？')
})

test('S8 关闭联网时说“搜一下”', async () => {
  test.setTimeout(300_000)
  const m = await ask('S8', '帮我上网搜一下今天的科技新闻', { web: 'off' })
  expect(m.status).toBe('done')
  expect.soft(tools(m)).not.toContain('web_search')
})

test('S9 追问上一轮网页', async () => {
  test.setTimeout(300_000)
  const first = await ask('S9a', '请读 https://en.wikipedia.org/wiki/Spaced_repetition ，一句话说明什么是间隔重复，并标注出处。')
  const m = await ask('S9b', '刚才那个来源里提到的 Leitner 系统具体是怎么做的？', { conversationId: first.conversationId })
  expect(m.status).toBe('done')
})

test('S10 界面：真实网页引用与快照', async () => {
  test.setTimeout(300_000)
  const dir = process.env.WEB_LIVE_SHOTS
  test.skip(!dir, '设置 WEB_LIVE_SHOTS 保存截图')
  const { navTo } = await import('./fixtures/nav')
  await navTo(page, /AI 对话/)
  await page
    .getByRole('button', { name: '新建' })
    .first()
    .click()
    .catch(() => {})
  await page.getByRole('radio', { name: '关闭' }).click()
  await page
    .getByRole('textbox', { name: '问积微，或交代一件事……' })
    .fill('请读 https://en.wikipedia.org/wiki/Forgetting_curve ，用两句话说明遗忘曲线，并标注出处。')
  await page.keyboard.press('Enter')
  const last = page.locator('.group\\/msg').last()
  await expect(last.getByText(/依据/)).toBeVisible({ timeout: 180_000 })
  await page.screenshot({ path: join(dir!, 'live-answer.png') })
  await last.getByText(/依据/).click()
  await page.screenshot({ path: join(dir!, 'live-basis.png') })
  await last.locator('.cite-chip').last().click()
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(dir!, 'live-snapshot.png') })
})
