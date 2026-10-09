import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { DocJSON, DocNode, ProposalOp } from '../src/shared/types'
import { COURSE_CUES, inCoursePage, makeCourseMedia, startCourseSite } from './fixtures/coursePage'

// 本地 HTTP 测试服务商只验证真实 transport → structured → proposal → Yjs / 复习卡持久化。
// 固定回复不代表模型理解了课程，也不能替代 JIWEI_IMPORT_PROVIDERS_FROM 的语义验收。
test.skip(process.platform !== 'darwin', '课程媒体夹具使用 macOS say -v Tingting')
test.describe.configure({ mode: 'serial' })

interface ApiRequest {
  model?: string
  messages?: { role: string; content?: string | { type: string; text?: string }[] | null }[]
  tools?: { type: string; function: { name: string; parameters?: { properties?: Record<string, unknown> } } }[]
}
interface SeenRequest {
  kind: 'outline' | 'quiz' | 'check'
  prompt: string
  tool: string
  model: string | undefined
}
interface PersistedProposal {
  id: string
  title: string
  status: string
  opStatus: string[]
  payload: { auto?: boolean; ops: ProposalOp[] }
}
let app: ElectronApplication
let page: Page
let site: Server
let provider: Server
let base = ''
let noteId = ''
let dataDir = ''
let tabId = ''
let invalidOnly = false
const requests: SeenRequest[] = []
const RAW_NOTE = '我的原话：A * B &amp; <标签>，保留标点。'
const QUESTION = '为什么要隔一段时间再复习？'
const FEEDBACK = '本地传输测试：已经收到这份回答。'
const panel = () => page.getByTestId('course-panel')

const active = () =>
  page.evaluate(async () => {
    const state = await window.jiwei.browser.state()
    return state.tabs.find((tab) => tab.id === state.activeId)!
  })
const textOf = (node: DocNode): string => node.text ?? (node.content ?? []).map(textOf).join(node.type === 'paragraph' ? '' : '\n')
const linksOf = (nodes: DocNode[]): string[] =>
  nodes.flatMap((node) => [
    ...(node.marks ?? [])
      .filter((mark) => mark.type === 'link' && typeof mark.attrs?.href === 'string')
      .map((mark) => String(mark.attrs!.href)),
    ...linksOf(node.content ?? [])
  ])
async function savedDoc(): Promise<{ xml: string; doc: DocJSON }> {
  const bytes = await page.evaluate((id) => window.jiwei.notes.loadDoc(id).then((b) => Array.from(b)), noteId)
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, new Uint8Array(bytes))
    return { xml: doc.getXmlFragment('default').toString(), doc: yDocToProsemirrorJSON(doc, 'default') as DocJSON }
  } finally {
    doc.destroy()
  }
}
async function allProposals(): Promise<PersistedProposal[]> {
  // 只读当前隔离测试知识库，包含已经自动接受的提案；公共 list 能力只返回 pending。
  return app.evaluate(
    ({ app }, { dataDir, noteId }) => {
      const { createRequire } = process.getBuiltinModule('module')
      const { join } = process.getBuiltinModule('path')
      if (!dataDir.startsWith(app.getPath('userData'))) throw new Error('Expected isolated test vault')
      const req = createRequire(join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(join(dataDir, 'jiwei.db'), { readonly: true, fileMustExist: true })
      try {
        const rows = db
          .prepare('SELECT id,title,status,ops,op_status FROM proposals WHERE note_id=? ORDER BY created_at,id')
          .all(noteId) as {
          id: string
          title: string
          status: string
          ops: string
          op_status: string
        }[]
        return rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          payload: JSON.parse(row.ops),
          opStatus: JSON.parse(row.op_status)
        }))
      } finally {
        db.close()
      }
    },
    { dataDir, noteId }
  )
}
async function expand(): Promise<void> {
  const button = panel().getByRole('button', { name: '展开课程面板' })
  if (await button.isVisible()) await button.click()
}
async function navigate(path: string): Promise<void> {
  await page.getByRole('textbox', { name: '地址栏' }).fill(`${base}${path}`)
  await page.keyboard.press('Enter')
  await expect.poll(() => active().then((tab) => tab.url)).toBe(`${base}${path}`)
}

test.beforeAll(async () => {
  test.setTimeout(720_000)
  provider = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) return void response.writeHead(404).end()
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      try {
        const payload = JSON.parse(body) as ApiRequest
        const submit = payload.tools?.find((tool) => tool.function.name === 'submit')
        const props = submit?.function.parameters?.properties ?? {}
        const kind = 'rows' in props ? 'outline' : 'question' in props ? 'quiz' : 'feedback' in props ? 'check' : null
        if (!submit || !kind) return void response.writeHead(422).end('Only structured course fixtures are supported')
        const prompt = (payload.messages ?? [])
          .map((message) =>
            typeof message.content === 'string' ? message.content : (message.content?.map((part) => part.text ?? '').join('') ?? '')
          )
          .join('\n')
        requests.push({ kind, prompt, tool: submit.function.name, model: payload.model })
        const output =
          kind === 'outline'
            ? {
                rows: [
                  ...(!invalidOnly
                    ? [{ cue: '间隔重复什么时候复习？', body: '在快要遗忘时复习，并逐步增加间隔。', t: 4, emphasis: true }]
                    : []),
                  { cue: '不应被写入的无证据内容', body: '测试服务商故意返回越界时间。', t: 900, emphasis: false }
                ],
                summary: '本地传输测试生成的总结。'
              }
            : kind === 'quiz'
              ? { question: QUESTION, answer: '在快要遗忘时复习，并逐步拉长间隔。', t: 4 }
              : { feedback: FEEDBACK }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: `course-fixture-${requests.length}`,
            object: 'chat.completion',
            created: 1,
            model: 'course-transport-fixture',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: `submit-${requests.length}`, type: 'function', function: { name: 'submit', arguments: JSON.stringify(output) } }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      } catch {
        response.writeHead(400).end('Invalid test request')
      }
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-course-learning-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  dataDir = await page.evaluate(() => window.jiwei.app.info().then((info) => info.dataDir))
  await page.evaluate(async (url) => {
    const provider = await window.jiwei.providers.save({
      kind: 'ollama',
      name: 'Course transport fixture',
      baseUrl: url,
      models: ['course-transport-fixture'],
      modelCaps: { 'course-transport-fixture': { tier: 'basic', vision: false } }
    })
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...settings.ai, chat: { providerId: provider.id, model: 'course-transport-fixture' }, effort: 'off' },
      browser: { ...settings.browser, proactivity: 'quiet' }
    })
  }, providerUrl)
  await page.reload()
  await page.waitForSelector('nav')
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-course-learning-media-'))
  await makeCourseMedia(page, dir)
  const siteInfo = await startCourseSite(dir)
  site = siteInfo.server
  base = siteInfo.base
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('课程传输与持久化测试')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText(RAW_NOTE)
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.insertText('我自己的线索')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '课程传输与持久化测试' }).then((notes) => notes.length)))
    .toBe(1)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '课程传输与持久化测试' }).then((notes) => notes[0].id))
  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await page.getByTestId('browser-start').getByRole('textbox').fill(`${base}/course`)
  await page.keyboard.press('Enter')
  await expect(panel()).toBeVisible({ timeout: 15_000 })
  await expand()
  await expect(page.getByTestId('course-transcript')).toContainText('第一讲，间隔重复')
  tabId = (await active()).id
  await page.evaluate((id) => window.jiwei.browser.seek(id, 12, false), tabId)
  await expect.poll(() => active().then((tab) => tab.video?.currentTime)).toBeCloseTo(12, 0)
  await page.locator('.cornell-row .cornell-body p').first().click()
  await page.locator('.cornell-row .cornell-body p').first().evaluate((paragraph) => {
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await panel().getByRole('button', { name: '插入时间点', exact: true }).click()
  await expect.poll(() => savedDoc().then((state) => state.xml)).toContain('?t=12')
  expect(textOf((await savedDoc()).doc)).toContain(RAW_NOTE)
})

test.afterAll(async () => {
  await app?.close()
  for (const server of [site, provider])
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
})

test('HTTP structured 整理：过滤无证据行，原话落入待审提案，接受前原行不变', async () => {
  test.setTimeout(45_000)
  const before = await savedDoc()
  await panel().getByRole('button', { name: '课后整理', exact: true }).click()
  await expect(page.getByRole('button', { name: '全部接受' })).toBeVisible({ timeout: 20_000 })
  const request = requests.find((request) => request.kind === 'outline')!
  expect(request).toMatchObject({ tool: 'submit', model: 'course-transport-fixture' })
  expect(request.prompt).toContain(COURSE_CUES[0].text)
  expect(request.prompt).toContain(RAW_NOTE)
  const pending = await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)
  expect(pending).toHaveLength(1)
  expect(pending[0].auto).toBe(false)
  expect(pending[0].opStatus.every((status) => status === 'pending')).toBe(true)
  const rows = pending[0].ops.filter((op) => op.op === 'insert_row')
  expect(rows).toHaveLength(1)
  expect(textOf({ content: rows[0].cue })).toContain('★')
  expect(textOf({ content: rows[0].body })).toContain(RAW_NOTE)
  expect(JSON.stringify(pending[0].ops)).not.toContain('不应被写入')
  const sourceId = (await active()).sourceId!
  const links = linksOf(rows[0].body)
  expect(links).toContain(`jiwei://source/${sourceId}?t=4`)
  expect(links).toContain(`jiwei://source/${sourceId}?t=12`)
  for (const href of links) {
    const t = Number(new URL(href).searchParams.get('t'))
    expect(COURSE_CUES.some((cue) => t >= cue.start - 5 && t <= cue.end + 5)).toBe(true)
  }
  expect((await savedDoc()).xml).toBe(before.xml)
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.proposals.list(id).then((list) => list.length), noteId)).toBe(0)
  await expect.poll(() => savedDoc().then((state) => state.xml)).not.toBe(before.xml)
  const after = (await savedDoc()).doc
  for (const row of before.doc.content?.filter((node) => node.type === 'cornellRow') ?? []) {
    expect(after.content?.find((node) => node.attrs?.id === row.attrs?.id)).toEqual(row)
  }
  expect((await allProposals())[0]).toMatchObject({ status: 'resolved', opStatus: ['accepted', 'accepted'] })
})

test('HTTP structured 返回全无效时间时，不创建提案也不修改笔记', async () => {
  const before = await savedDoc()
  const proposalIds = (await allProposals()).map((proposal) => proposal.id)
  const sourceId = (await active()).sourceId!
  invalidOnly = true
  try {
    await expect(
      page.evaluate(({ sourceId, noteId }) => window.jiwei.course.organize(sourceId, noteId), { sourceId, noteId })
    ).rejects.toThrow(/时间证据/)
  } finally {
    invalidOnly = false
  }
  expect(requests.filter((request) => request.kind === 'outline')).toHaveLength(2)
  expect((await allProposals()).map((proposal) => proposal.id)).toEqual(proposalIds)
  expect((await savedDoc()).xml).toBe(before.xml)
})

test('HTTP quiz/check → 显式加入复习：auto提案确实落库为卡片并继续原生播放', async () => {
  test.setTimeout(60_000)
  await navigate('/empty')
  await expect(panel()).toHaveCount(0)
  await navigate('/course?learning-quiz=1')
  await expect(panel()).toBeVisible()
  await expand()
  await expect(page.getByTestId('course-transcript')).toContainText('第一讲，间隔重复')
  await panel().getByLabel('边看边测', { exact: true }).click()
  await expect.poll(() => active().then((tab) => tab.course.quiz)).toBe(true)
  await inCoursePage(app, `${base}/course?learning-quiz=1`, 'document.querySelector("video").play()')
  const quiz = page.getByTestId('course-quiz')
  await expect(quiz.getByRole('textbox')).toBeVisible({ timeout: 30_000 })
  await expect(quiz).toContainText(QUESTION)
  await expect.poll(() => active().then((tab) => tab.video?.paused)).toBe(true)
  expect(requests.find((request) => request.kind === 'quiz')?.prompt).toContain('[transcript t=0,9]')
  await quiz.getByRole('textbox').fill('在快要遗忘时复习。')
  await quiz.getByRole('button', { name: '对照答案', exact: true }).click()
  await expect(quiz).toContainText(FEEDBACK, { timeout: 15_000 })
  expect(requests.find((request) => request.kind === 'check')?.prompt).toContain('在快要遗忘时复习。')
  const priorCards = await page.evaluate((id) => window.jiwei.review.forNote(id).then((cards) => cards.map((card) => card.id)), noteId)
  const before = await savedDoc()
  await quiz.getByRole('button', { name: '加入复习', exact: true }).click()
  await expect(quiz).toHaveCount(0)
  await expect.poll(() => active().then((tab) => tab.video?.paused)).toBe(false)
  await expect
    .poll(() => allProposals().then((list) => list.filter((proposal) => proposal.payload.auto && proposal.status === 'resolved').length))
    .toBe(1)
  const proposal = (await allProposals()).find((proposal) => proposal.payload.auto)!
  expect(proposal.opStatus).toEqual(['accepted'])
  expect(proposal.payload.ops).toHaveLength(1)
  expect(proposal.payload.ops[0].op).toBe('insert_row')
  await expect.poll(() => savedDoc().then((state) => textOf(state.doc))).toContain(QUESTION)
  await expect
    .poll(() =>
      page
        .evaluate((id) => window.jiwei.review.forNote(id).then((cards) => cards.map((card) => card.id)), noteId)
        .then((ids) => ids.filter((id) => !priorCards.includes(id)).length)
    )
    .toBe(1)
  const after = (await savedDoc()).doc
  const newRow = (after.content ?? []).find((node) => node.type === 'cornellRow' && textOf(node).includes(QUESTION))!
  const cards = await page.evaluate((id) => window.jiwei.review.forNote(id), noteId)
  expect(cards.some((card) => card.rowId === newRow.attrs?.id && !card.suspended)).toBe(true)
  for (const row of before.doc.content?.filter((node) => node.type === 'cornellRow') ?? []) {
    expect(after.content?.find((node) => node.attrs?.id === row.attrs?.id)).toEqual(row)
  }
  const resumeTime = (await active()).video!.currentTime
  await expect
    .poll(() => inCoursePage<number>(app, `${base}/course?learning-quiz=1`, 'document.querySelector("video").currentTime'))
    .toBeGreaterThan(resumeTime + 0.5)
  await inCoursePage(app, `${base}/course?learning-quiz=1`, 'document.querySelector("video").pause()')
})
