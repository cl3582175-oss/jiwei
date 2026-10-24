import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import JSZip from 'jszip'
import { navTo } from './fixtures/nav'
import { writeOpenAiCompletion } from './fixtures/openaiResponse'

// v0.9 创作工坊：素材来自知识库 → 结构 → 起草（共写 / 教练）→ 打磨 → 回流卡片 → 导出 Word / PDF / Markdown / PPTX。
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server
const prompts: { system: string; prompt: string }[] = []
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-works-export-'))
const shots = process.env.SHOTS_DIR

function reply(system: string, prompt: string): unknown {
  const refs = [...prompt.matchAll(/"ref":"(M\d+)"/g)].map((m) => m[1])
  const m1 = refs[0] ?? 'M1'
  if (system.includes('推荐 3–5 个'))
    return { topics: [{ title: '间隔重复为什么有效', angle: '从遗忘曲线讲到复习安排', audience: '同学', why: '你的相关卡片都很稳' }] }
  if (system.includes('为这篇图文长文写提纲'))
    return {
      sections: [
        { title: '为什么会遗忘', points: ['遗忘曲线', '提取练习'], sources: [m1, 'M99'] },
        { title: '间隔重复怎么用', points: ['安排复习间隔'], sources: [m1] },
        { title: '常见误区', points: ['只看不测'], sources: [] }
      ]
    }
  if (system.includes('写这一节的正文')) return { body: `遗忘并不可怕，按间隔复习能把记忆稳住 [${m1}]。编造的引用 [M99] 应被去掉。` }
  if (system.includes('写作教练'))
    return { questions: ['你自己最常在什么时候忘记？', '素材里哪句话最能说明遗忘曲线？'], tips: ['先举一个例子'] }
  if (system.includes('为这份课件写逐页结构'))
    return {
      slides: [
        { title: '间隔重复', bullets: ['给同学的十分钟分享'], notes: '', sources: [] },
        { title: '遗忘曲线', bullets: ['20 分钟后忘掉四成', '复习让曲线变平'], notes: '先问大家记得多少', sources: [m1] },
        { title: '总结与提问', bullets: ['按间隔复习'], notes: '', sources: [] }
      ]
    }
  if (system.includes('补全成可以直接讲的课件'))
    return {
      slides: [
        { title: '间隔重复：少花时间记得更牢', bullets: ['给同学的十分钟分享'], notes: '大家好，今天讲讲怎么复习更省力。', sources: [] },
        { title: '遗忘曲线', bullets: ['学完 20 分钟忘掉约四成', '每次复习都让曲线变平'], notes: '这是艾宾浩斯的发现。', sources: [m1] },
        { title: '总结与提问', bullets: ['按间隔复习，先测再看'], notes: '有什么问题？', sources: [] }
      ]
    }
  if (system.includes('讲解视频的分镜'))
    return {
      scenes: [
        {
          template: 'title',
          title: '间隔重复',
          subtitle: '一分钟讲清楚',
          narration: '今天用一分钟，讲清楚间隔重复为什么有效。',
          sources: []
        },
        {
          template: 'bullets',
          title: '遗忘曲线',
          items: ['二十分钟忘掉四成', '一天后只剩三成'],
          narration: '艾宾浩斯发现，学完二十分钟就会忘掉四成。',
          sources: [m1]
        },
        {
          template: 'formula',
          title: '记忆保持率',
          steps: ['R = e^{-t/S}', 'S \\uparrow \\Rightarrow R \\uparrow'],
          narration: '保持率随时间指数下降，稳定性越高，下降越慢。',
          sources: []
        },
        {
          template: 'graph',
          title: '指数衰减',
          functions: ['exp(-x/2)'],
          view: [0, 8, 0, 1.2],
          narration: '这条曲线就是遗忘的样子。',
          sources: []
        },
        { template: 'graph', title: '坏的函数图', functions: ['alert(1)'], narration: '这个场景应被去掉。', sources: [] },
        {
          template: 'chart',
          title: '复习之后',
          kind: 'bar',
          categories: ['不复习', '复习一次', '复习三次'],
          series: [{ name: '一周后保持率', data: [20, 45, 80] }],
          narration: '每复习一次，一周后记得的就更多。',
          sources: []
        },
        {
          template: 'diagram',
          title: '复习的循环',
          code: 'flowchart LR\n  A[学习] --> B[提取]\n  B --> C[间隔]\n  C --> B',
          narration: '先学，再提取，隔一段时间再提取。',
          sources: []
        },
        {
          template: 'summary',
          title: '记住三点',
          items: ['先测再看', '间隔逐渐拉长'],
          narration: '记住：先测再看，间隔逐渐拉长。',
          sources: []
        }
      ]
    }
  if (system.includes('以目标受众的身份审读'))
    return {
      audience: [{ part: 0, issue: '开头太快进入概念', suggestion: '先讲一个忘记的例子' }],
      facts: [{ part: 1, quote: '能把记忆稳住', verdict: 'unsupported', note: '素材只说能减缓遗忘' }],
      unclear: [{ part: 1, point: '复习间隔为什么要逐渐拉长', question: '为什么间隔重复的间隔要逐渐拉长？' }]
    }
  return { text: 'ok' }
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body)
      const text = (c: unknown): string =>
        typeof c === 'string' ? c : Array.isArray(c) ? c.map((v: { text?: string }) => v.text ?? '').join('') : ''
      const system = text(input.messages.find((m: { role: string }) => m.role === 'system')?.content)
      const prompt = text(input.messages.filter((m: { role: string }) => m.role === 'user').at(-1)?.content)
      prompts.push({ system, prompt })
      writeOpenAiCompletion(res, {
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
              tool_calls: [
                { id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify(reply(system, prompt)) } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 2000, completion_tokens: 600, total_tokens: 2600 }
      }, !!input.stream)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-works-'))}`],
    env: {
      ...process.env,
      JIWEI_TEST_NETWORK: '1',
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_EXPORT_DIR: exportDir
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  await page.evaluate(async (baseUrl) => {
    const j = window.jiwei
    const provider = await j.providers.save({ kind: 'ollama', name: '受控创作模型', baseUrl, models: ['deepseek-flash'] } as never)
    const s = await j.settings.get()
    await j.settings.set({ ai: { ...s.ai, chat: { providerId: provider.id, model: 'deepseek-flash' }, effort: 'off' } } as never)
    const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    const n = await j.notes.create({ title: '遗忘曲线' })
    await j.proposals.create({
      noteId: n.id,
      title: 'x',
      ops: [{ op: 'insert_row', afterRowId: null, cue: [p('遗忘曲线是什么')], body: [p('间隔重复能减缓遗忘，学完二十分钟后会忘掉约四成')] }]
    } as never)
  }, baseUrl)
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /^笔记/, { again: true })
  await page.locator('[data-note-id]').filter({ hasText: '遗忘曲线' }).first().click()
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect
    .poll(
      () => page.evaluate(() => window.jiwei.knowledge.search('间隔重复', { type: 'all' }).then((h) => h.map((x) => x.title).join(','))),
      { timeout: 30_000 }
    )
    .toContain('遗忘曲线')
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

test('长文：素材 → 结构 → 共写起草 → 打磨与回流卡片 → 导出 Word / PDF / Markdown', async () => {
  await navTo(page, /^作品/)
  await expect(page.getByTestId('works-view')).toContainText('还没有作品')
  if (shots) await page.screenshot({ path: join(shots, '301-works-empty.png') })
  await page.getByRole('button', { name: /图文长文/ }).click()
  const dialog = page.getByTestId('new-work-dialog')
  await dialog.getByRole('textbox', { name: '选题' }).fill('间隔重复为什么有效')
  await dialog.getByRole('button', { name: '同学', exact: true }).click()
  await dialog.getByRole('radio', { name: '共写', exact: true }).click()
  if (shots) await page.screenshot({ path: join(shots, '302-new-work.png') })
  await dialog.getByRole('button', { name: '开始创作' }).click()
  // 有选题时直接进入素材，并自动收集
  const mats = page.getByTestId('work-materials')
  await expect(mats).toContainText('遗忘曲线', { timeout: 20_000 })
  await expect(mats).toContainText('M1')
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '生成结构' }).click()
  const outline = page.getByTestId('work-outline')
  await expect(outline.locator('[data-part]')).toHaveCount(3)
  // 编造的素材编号被去掉，只保留 M1
  await expect(outline.locator('[data-part="0"]')).toContainText('M1')
  await expect(outline).not.toContainText('M99')
  expect(prompts.at(-1)!.prompt).toContain('间隔重复能减缓遗忘')
  // 改标题后自动保存
  await outline.locator('[data-part="2"]').getByRole('textbox', { name: '标题' }).fill('三个常见误区')
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.works.list()))[0].content?.parts[2]?.title).toBe('三个常见误区')
  if (shots) await page.screenshot({ path: join(shots, '303-outline.png') })
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '起草全部章节' }).click()
  const sections = page.getByTestId('work-sections')
  await expect(sections.locator('textarea').first()).toHaveValue(/按间隔复习/, { timeout: 20_000 })
  await expect(sections.locator('textarea').nth(2)).toHaveValue(/按间隔复习/)
  if (shots) await page.screenshot({ path: join(shots, '304-draft.png') })
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '开始打磨' }).click()
  const polish = page.getByTestId('work-polish')
  await expect(polish).toContainText('开头太快进入概念')
  await expect(polish).toContainText('没有素材依据')
  await expect(polish).toContainText('为什么间隔重复的间隔要逐渐拉长')
  if (shots) await page.screenshot({ path: join(shots, '305-polish.png') })
  await polish.getByRole('button', { name: '生成复习卡片' }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '回流' }).then((n) => n.length))).toBe(1)
  await page.getByRole('button', { name: '下一步' }).click()
  const exp = page.getByTestId('work-export')
  for (const f of ['Word', 'PDF', 'Markdown']) {
    await exp.getByRole('button', { name: f }).click()
    await expect(page.getByText(/已导出《/).last()).toBeVisible()
  }
  const base = join(exportDir, '间隔重复为什么有效')
  await expect.poll(() => existsSync(`${base}.md`) && existsSync(`${base}.docx`) && existsSync(`${base}.pdf`)).toBe(true)
  const md = readFileSync(`${base}.md`, 'utf8')
  expect(md).toContain('## 为什么会遗忘')
  expect(md).toContain('[^1]: 遗忘曲线')
  expect(md).not.toContain('M99')
  const saved = await page.evaluate(() => window.jiwei.works.list())
  expect(JSON.stringify(saved)).not.toContain('[M99]')
  expect(readFileSync(`${base}.pdf`).subarray(0, 4).toString()).toBe('%PDF')
  const docx = await JSZip.loadAsync(readFileSync(`${base}.docx`))
  expect(await docx.file('word/document.xml')!.async('string')).toContain('间隔重复怎么用')
  await expect(page.getByTestId('work-export').locator('..')).toContainText('用到了 1 / 1 条素材')
  if (shots) await page.screenshot({ path: join(shots, '306-done.png') })
})

test('课件：逐页结构 → 补全 → 导出 PPTX（讲者备注写明出处）', async () => {
  await page.getByRole('button', { name: '全部作品' }).click()
  await page.getByRole('button', { name: '新建作品' }).click()
  const dialog = page.getByTestId('new-work-dialog')
  await dialog.getByRole('radio', { name: /课件 PPT/ }).click()
  await dialog.getByRole('textbox', { name: '选题' }).fill('间隔重复十分钟分享')
  await dialog.getByRole('button', { name: '开始创作' }).click()
  await expect(page.getByTestId('work-materials')).toContainText('遗忘曲线', { timeout: 20_000 })
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '生成结构' }).click()
  await expect(page.getByTestId('work-outline').locator('[data-part]')).toHaveCount(3)
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '补全全部页面' }).click()
  const slides = page.getByTestId('work-slides')
  await expect(slides).toContainText('少花时间记得更牢')
  if (shots) await page.screenshot({ path: join(shots, '307-slides.png') })
  await page.getByTestId('work-steps').getByRole('button', { name: /成品/ }).click()
  await page.getByTestId('work-export').getByRole('button', { name: 'PowerPoint' }).click()
  const file = join(exportDir, '间隔重复十分钟分享.pptx')
  await expect.poll(() => existsSync(file)).toBe(true)
  const zip = await JSZip.loadAsync(readFileSync(file))
  const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
  expect(slideFiles).toHaveLength(3)
  expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('遗忘曲线')
  const notes = await Promise.all(
    Object.keys(zip.files)
      .filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f))
      .map((f) => zip.file(f)!.async('string'))
  )
  expect(notes.join('')).toContain('出处：遗忘曲线')
})

test('教练模式：只给提示问题，不替写正文', async () => {
  const id = await page.evaluate(async () => {
    const w = await window.jiwei.works.create({ type: 'article', topic: '如何复习更省力', mode: 'coach' })
    await window.jiwei.works.gather(w.id)
    await window.jiwei.works.outline(w.id)
    return w.id
  })
  await page.getByRole('button', { name: '全部作品' }).click()
  await page.locator('[data-work="如何复习更省力"]').click()
  await page.getByTestId('work-steps').getByRole('button', { name: /起草/ }).click()
  await page.getByRole('button', { name: '为每一节生成提示问题' }).click()
  await expect(page.getByTestId('coach-questions').first()).toContainText('你自己最常在什么时候忘记')
  const w = await page.evaluate((id) => window.jiwei.works.get(id), id)
  expect(w.content?.kind === 'article' && w.content.parts.every((p) => !p.body)).toBe(true)
})

test('讲解视频：分镜（去掉非法场景）→ 预览 → 渲染 MP4（画面、音轨、字幕、分镜表）→ 导出', async () => {
  test.setTimeout(300_000)
  await page.getByRole('button', { name: '全部作品' }).click()
  await page.getByRole('button', { name: '新建作品' }).click()
  const dialog = page.getByTestId('new-work-dialog')
  await dialog.getByRole('radio', { name: /讲解视频/ }).click()
  await dialog.getByRole('textbox', { name: '选题' }).fill('间隔重复一分钟')
  await dialog.getByRole('button', { name: '开始创作' }).click()
  await expect(page.getByTestId('work-materials')).toContainText('遗忘曲线', { timeout: 20_000 })
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('button', { name: '生成分镜' }).click()
  const board = page.getByTestId('storyboard')
  await expect(board.locator(':scope > li')).toHaveCount(7)
  await expect(board).not.toContainText('坏的函数图')
  await expect(board.locator('.katex').first()).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '308-storyboard.png') })
  await page.getByRole('button', { name: '下一步' }).click()
  await page.getByRole('radio', { name: '不配音（只有字幕）' }).click()
  const preview = page.getByTestId('video-preview')
  // 第 7 秒：第二个场景旁白中（每个场景开头有 0.35 秒留白，那时本来没有字幕）
  await preview.getByRole('slider', { name: '预览' }).fill('7')
  await expect(preview.locator('[data-caption]')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '309-video-preview.png') })
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.works.list())).find((w) => w.type === 'video')?.content)
    .toMatchObject({ voice: { engine: 'none' } })
  await page.getByTestId('work-steps').getByRole('button', { name: /成品/ }).click()
  await page.getByRole('button', { name: '渲染视频' }).click()
  const done = page.getByTestId('video-done')
  await expect(done.getByTestId('video-player')).toBeVisible({ timeout: 240_000 })
  if (shots) await page.screenshot({ path: join(shots, '310-video-done.png') })
  for (const name of ['导出 MP4', '导出字幕 SRT', '导出分镜表']) await done.getByRole('button', { name }).click()
  const mp4 = join(exportDir, '间隔重复一分钟.mp4')
  await expect
    .poll(
      () => existsSync(mp4) && existsSync(join(exportDir, '间隔重复一分钟.srt')) && existsSync(join(exportDir, '间隔重复一分钟-分镜.json'))
    )
    .toBe(true)
  const head = readFileSync(mp4)
  expect(head.subarray(4, 8).toString()).toBe('ftyp')
  expect(head.length).toBeGreaterThan(50_000)
  const srt = readFileSync(join(exportDir, '间隔重复一分钟.srt'), 'utf8')
  expect(srt).toContain('00:00:00,350 -->')
  expect(srt).toContain('艾宾浩斯发现')
  const story = JSON.parse(readFileSync(join(exportDir, '间隔重复一分钟-分镜.json'), 'utf8')) as { scenes: { duration: number }[] }
  expect(story.scenes).toHaveLength(7)
  const total = story.scenes.reduce((n, s) => n + s.duration, 0)
  // 用应用下载的 ffmpeg 检查流与时长（本机有时）
  const ff = join(process.env.HOME ?? '', 'Library/Application Support/jiwei-models/ffmpeg/ffmpeg')
  if (existsSync(ff)) {
    const { spawnSync } = await import('child_process')
    const info = spawnSync(ff, ['-hide_banner', '-i', mp4]).stderr.toString()
    expect(info).toMatch(/Video: h264.*1280x720/)
    expect(info).toMatch(/Audio: aac/)
    const [, h, m, sec] = /Duration: (\d+):(\d+):([\d.]+)/.exec(info)!
    expect(Math.abs(Number(h) * 3600 + Number(m) * 60 + Number(sec) - total)).toBeLessThan(1)
  }
})
