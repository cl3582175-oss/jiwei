import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { navTo } from './fixtures/nav'

let app: ElectronApplication,
  page: Page,
  server: Server,
  publicNote = ''
const requests: string[] = []
let generation = 0

async function sqlRun(sql: string, args: unknown[] = []): Promise<void> {
  await app.evaluate(
    ({ app }, { sql, args }) => {
      const path = process.getBuiltinModule('path'),
        require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json')),
        Database = require('better-sqlite3') as typeof import('better-sqlite3'),
        db = new Database(path.join(app.getPath('userData'), 'data', 'jiwei.db'))
      try {
        db.prepare(sql).run(...args)
      } finally {
        db.close()
      }
    },
    { sql, args }
  )
}
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (v: Buffer) => {
      body += v.toString()
    })
    req.on('end', () => {
      const podcast = body.includes('discover.podcast')
      if (podcast) requests.push(body)
      const result = podcast
        ? {
            paragraphs: Array.from(
              { length: 3 },
              (_, i) => `讲稿${++generation}段${i + 1}。${'先想一想条件概率何时成立，读精选再对照自己的理解。'.repeat(20)}`
            )
          }
        : { text: '先从今天要复习的问题开始。' }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'p',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify(result) } }]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-podcast-')),
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.addInitScript(() => {
    // 只验证播放条状态；测试替身不会证明真实系统声音、设备或听感。
    const state = {
      events: [] as { type: string; text?: string; rate?: number; lang?: string }[],
      current: null as null | { text: string; rate: number; lang: string; onend?: () => void; onerror?: (e: { error: string }) => void }
    }
    const synth = {
      speaking: false,
      paused: false,
      getVoices: () => [
        { voiceURI: 'zh', name: '中文系统语音', lang: 'zh-CN', default: true },
        { voiceURI: 'en', name: 'English system voice', lang: 'en-US', default: false }
      ],
      addEventListener: () => {},
      removeEventListener: () => {},
      speak(u: typeof state.current) {
        this.speaking = true
        this.paused = false
        state.current = u
        state.events.push({ type: 'speak', text: u?.text, rate: u?.rate, lang: u?.lang })
      },
      cancel() {
        this.speaking = false
        this.paused = false
        state.current?.onerror?.({ error: 'interrupted' })
        state.current = null
        state.events.push({ type: 'cancel' })
      },
      pause() {
        this.paused = true
        state.events.push({ type: 'pause' })
      },
      resume() {
        this.paused = false
        state.events.push({ type: 'resume' })
      }
    }
    class Utterance {
      text: string
      lang = ''
      rate = 1
      voice: unknown = null
      onend: unknown = null
      onerror: unknown = null
      constructor(text: string) {
        this.text = text
      }
    }
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true })
    Object.assign(window, {
      __speech: state,
      __speechEnd: () => {
        synth.speaking = false
        state.current?.onend?.()
      }
    })
  })
  const setup = await page.evaluate(async () => {
    const n = await window.jiwei.notes.create({ title: '允许的问题笔记' }),
      p = await window.jiwei.notes.create({ title: 'PRIVATE_PODCAST_NOTE' })
    return { n: n.id, p: p.id }
  })
  publicNote = setup.n
  for (const [id, question, answer] of [
    [setup.n, 'PUBLIC_QUESTION 条件何时成立？', 'PRIVATE_ANSWER_NEVER_SEND'],
    [setup.p, 'PRIVATE_PODCAST_QUESTION', 'PRIVATE_BODY']
  ]) {
    await page.evaluate(
      async ({ id, question, answer }) => {
        const paragraph = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text }] }]
        await window.jiwei.proposals.create({
          noteId: id,
          title: '播客素材自创题',
          ops: [{ op: 'insert_row', afterRowId: null, cue: paragraph(question), body: paragraph(answer) }]
        })
      },
      { id, question, answer }
    )
    await navTo(page, /^笔记/)
    await page.getByText(id === setup.n ? '允许的问题笔记' : 'PRIVATE_PODCAST_NOTE', { exact: true }).click()
    await page.getByRole('button', { name: '全部接受', exact: true }).click()
    await expect.poll(() => page.evaluate((id) => window.jiwei.review.forNote(id), id)).toHaveLength(1)
  }
  await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true }), setup.p)
  // 构造有当前许可依据的受控精选；生产精选由每日流程附加该指纹。
  const excluded = await app.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'),
      db = new (load('better-sqlite3'))(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
    try {
      return ['notes', 'sources'].map((table) => db.prepare(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL OR ai_excluded=1 ORDER BY id`).all().map((r: { id: string }) => r.id))
    } finally { db.close() }
  })
  const blocked = ((await page.evaluate(() => window.jiwei.settings.get())).browser?.aiBlockedSites ?? []).map((s) => s.toLowerCase()).sort(),
    privacySignature = createHash('sha256').update(JSON.stringify({ excluded, excludedMistakes: [], blocked })).digest('hex')
  for (const [id, title, related] of [
    ['public', 'PUBLIC_PICK 条件概率', '[]'],
    ['private', 'PRIVATE_PICK', JSON.stringify([{ type: 'note', id: setup.p }])]
  ])
    await sqlRun(
      "INSERT INTO feed_items(id, url, title, summary, reason, score, origin, status, picked_at, fetched_at, related, created_at, updated_at, updated_by) VALUES (?, ?, ?, '', '补足条件概率方向', ?, 'feed', 'picked', ?, ?, ?, ?, ?, 'test')",
      [id, `https://example.org/${id}`, title, JSON.stringify({ privacySignature, related: JSON.parse(related) }), Date.now(), Date.now(), related, Date.now(), Date.now()]
    )
  await page.evaluate(async (base) => {
    const provider = await window.jiwei.providers.save({
        name: 'Podcast controlled',
        kind: 'ollama',
        baseUrl: base,
        models: ['deepseek-flash']
      }),
      s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, chat: { providerId: provider.id, model: 'deepseek-flash' }, effort: 'off' },
      budget: { daily: 50, monthly: 500, perRun: 5 },
      discover: { ...s.discover, dailyBudget: 5 }
    })
  }, base)
  await navTo(page, /^今日/)
  await page.reload()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

test('P7 默认关闭，设置启用后真实生成与当天覆盖，费用可查；答案及私有内容不外发', async () => {
  await expect(page.getByTestId('podcast-player')).toHaveCount(0)
  expect(requests).toHaveLength(0)
  await page.getByRole('button', { name: /^设置/ }).click()
  await page.getByRole('button', { name: '发现', exact: true }).click()
  await page.getByRole('switch', { name: '每日学习播客', exact: true }).click()
  await page.keyboard.press('Escape')
  const player = page.getByTestId('podcast-player')
  await expect(player).toBeVisible()
  await player.getByRole('button', { name: '生成讲稿', exact: true }).click()
  await expect(player.getByTestId('podcast-paragraph')).toContainText('讲稿1')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toContain('PUBLIC_QUESTION')
  expect(requests[0]).toContain('PUBLIC_PICK')
  expect(requests[0]).not.toMatch(/PRIVATE_PODCAST|PRIVATE_PICK|PRIVATE_ANSWER|PRIVATE_BODY/)
  const first = await page.evaluate(() => window.jiwei.discover.podcast())
  expect(first.script?.paragraphs).toHaveLength(3)
  await player.getByRole('button', { name: '重新生成', exact: true }).click()
  await expect(player.getByTestId('podcast-paragraph')).toContainText('讲稿4')
  const second = await page.evaluate(() => window.jiwei.discover.podcast())
  expect(second.script?.date).toBe(first.script?.date)
  expect(second.script?.createdAt).toBeGreaterThan(first.script?.createdAt ?? 0)
  await player.getByRole('button', { name: '查看文字版', exact: true }).click()
  await expect(player.getByTestId('podcast-script')).toContainText('讲稿6')
  await page.reload()
  await page.waitForSelector('nav')
  await expect(page.getByTestId('podcast-paragraph')).toContainText('讲稿4')
  expect(requests).toHaveLength(2)
  expect((await page.evaluate(() => window.jiwei.discover.status())).spent).toBeGreaterThan(0)
})
test('P7 播放、暂停、继续、上下段、语速和英文语音；切换页面取消朗读', async () => {
  const player = page.getByTestId('podcast-player')
  await player.getByRole('button', { name: '播放', exact: true }).click()
  await player.getByRole('button', { name: '暂停', exact: true }).click()
  await player.getByRole('button', { name: '继续播放', exact: true }).click()
  await player.getByRole('button', { name: '下一段', exact: true }).click()
  await expect(player.getByTestId('podcast-paragraph')).toContainText('讲稿5')
  await player.getByRole('button', { name: '上一段', exact: true }).click()
  await player.getByLabel('语速').selectOption('1.5')
  await player.getByLabel('系统音色').selectOption('en')
  const events = await page.evaluate(
    () => (window as unknown as { __speech: { events: { type: string; rate?: number; lang?: string }[] } }).__speech.events
  )
  expect(events.map((e) => e.type)).toContain('pause')
  expect(events.map((e) => e.type)).toContain('resume')
  expect(events.filter((e) => e.type === 'speak').at(-1)).toMatchObject({ rate: 1.5, lang: 'en-US' })
  await navTo(page, /^方向/)
  expect(await page.evaluate(() => speechSynthesis.speaking)).toBe(false)
  await navTo(page, /^今日/)
  await expect(player.getByRole('button', { name: '播放', exact: true })).toBeVisible()
})
test('P7 私有设置变化使旧稿失效，零预算不产生请求', async () => {
  await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true }), publicNote)
  await expect(page.getByTestId('podcast-player')).toContainText('素材或隐私设置已变化')
  expect((await page.evaluate(() => window.jiwei.discover.podcast())).script).toBeNull()
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ discover: { ...s.discover, dailyBudget: 0 } })
  })
  const before = requests.length
  await page.getByTestId('podcast-player').getByRole('button', { name: '生成讲稿', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.discover.podcast())).toMatchObject({ status: 'budget' })
  expect(requests).toHaveLength(before)
})
