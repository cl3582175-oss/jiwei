import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { createCanvas } from '@napi-rs/canvas'
import { navTo } from './fixtures/nav'

// 对话附件真实验收（v0.14.4 审查）：真实服务商、真实文件，走界面添加与发送。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库> JIWEI_PMBOK=<PDF> [JIWEI_LIVE_PPTX=<pptx>] [JIWEI_LIVE_OUT=<目录>]
//   npx playwright test e2e/attachments-live.spec.ts
// 密钥以加密形态复制到临时目录，不解密、不输出。回答、请求用量与截图写到 JIWEI_LIVE_OUT 供人工审查。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source || !process.env.JIWEI_PMBOK, '需要 JIWEI_IMPORT_PROVIDERS_FROM 与 JIWEI_PMBOK')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication, page: Page
const dir = mkdtempSync(join(tmpdir(), 'jiwei-attach-live-'))
const out = process.env.JIWEI_LIVE_OUT ?? dir
const log: { step: string; question: string; answer: string; citations: unknown; usage: unknown }[] = []

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${join(dir, 'user')}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
test.afterAll(async () => {
  writeFileSync(join(out, 'attachments-live.json'), JSON.stringify(log, null, 2))
  await app?.close()
})

async function pick(paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
  }, paths)
  await page.getByRole('button', { name: '添加附件', exact: true }).last().click()
  for (const p of paths) {
    const name = p.split('/').pop()!
    await expect(page.getByTestId('attachment-chip').filter({ hasText: name })).toHaveAttribute('data-status', /^(ready|recognizing)$/, {
      timeout: 600_000
    })
  }
}

async function ask(step: string, question: string): Promise<string> {
  const input = page.locator('textarea').last()
  await input.fill(question)
  await page.keyboard.press('Enter')
  const last = page.locator('.group\\/msg').last()
  await expect(last).toBeVisible()
  await expect
    .poll(
      async () => {
        const convs = await page.evaluate(() => window.jiwei.chat.conversations())
        const msgs = await page.evaluate((id) => window.jiwei.chat.messages(id), convs[0].id)
        return msgs.at(-1)?.role === 'assistant' ? msgs.at(-1)!.status : 'pending'
      },
      { timeout: 600_000, intervals: [2000] }
    )
    .not.toMatch(/pending|streaming/)
  const convs = await page.evaluate(() => window.jiwei.chat.conversations())
  const msgs = await page.evaluate((id) => window.jiwei.chat.messages(id), convs[0].id)
  const m = msgs.at(-1)!
  log.push({ step, question, answer: m.content, citations: m.citations, usage: (m as { usage?: unknown }).usage ?? null })
  await page.screenshot({ path: join(out, `${step}.png`) })
  expect(m.status, m.error ?? '').toBe('done')
  return m.content
}

async function newChat(): Promise<void> {
  await navTo(page, /AI 对话/)
  await page.getByRole('button', { name: '新对话', exact: true }).first().click()
}

test('服务商可用', async () => {
  const providers = await page.evaluate(() => window.jiwei.providers.list())
  expect(providers.some((p) => p.hasKey)).toBe(true)
})

test('PMBOK 预览 PDF：多轮追问与页码引用', async () => {
  test.setTimeout(1_800_000)
  const pdf = join(dir, 'PMBOK8预览.pdf')
  copyFileSync(process.env.JIWEI_PMBOK!, pdf)
  await newChat()
  await pick([pdf])
  await page.screenshot({ path: join(out, '01-pdf-ready.png') })
  await ask('01-pdf-overview', '这份文件主要讲什么？列出主要部分，并标明页码。')
  await ask('02-pdf-detail', '里面对“价值交付系统”是怎么定义的？引用原文页码。')
  await ask('03-pdf-follow', '那它和项目管理原则之间是什么关系？')
})

test('xlsx 出图', async () => {
  test.setTimeout(600_000)
  const zip = new JSZip()
  const months = ['1月', '2月', '3月', '4月', '5月', '6月']
  const rev = [120, 135, 128, 160, 172, 190]
  const cost = [80, 82, 90, 95, 101, 108]
  const ss = ['月份', '收入（万元）', '成本（万元）', ...months]
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
  )
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="经营数据" sheetId="1" r:id="rId1"/></sheets></workbook>'
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'
  )
  zip.file(
    'xl/sharedStrings.xml',
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${ss.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`
  )
  const rows = months
    .map(
      (_, i) =>
        `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>${i + 3}</v></c><c r="B${i + 2}"><v>${rev[i]}</v></c><c r="C${i + 2}"><v>${cost[i]}</v></c></row>`
    )
    .join('')
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>${rows}</sheetData></worksheet>`
  )
  const xlsx = join(dir, '上半年经营数据.xlsx')
  writeFileSync(xlsx, await zip.generateAsync({ type: 'nodebuffer' }))
  await newChat()
  await pick([xlsx])
  await ask('04-xlsx-chart', '把收入和成本画成折线图，并算出每个月的毛利。')
  await expect(page.locator('.group\\/msg').last().locator('canvas, svg').first()).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: join(out, '04-xlsx-chart-rendered.png') })
})

test('pptx 逐页概括', async () => {
  test.skip(!process.env.JIWEI_LIVE_PPTX, '需要 JIWEI_LIVE_PPTX')
  test.setTimeout(600_000)
  const pptx = join(dir, '融资路演.pptx')
  copyFileSync(process.env.JIWEI_LIVE_PPTX!, pptx)
  await newChat()
  await pick([pptx])
  await page.screenshot({ path: join(out, '05-pptx-starters.png') })
  await ask('05-pptx-pages', '逐页概括这份演示文稿，每页一句话，标明页码。')
})

test('图片题目', async () => {
  test.setTimeout(600_000)
  const canvas = createCanvas(900, 360)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, 900, 360)
  ctx.fillStyle = '#111'
  ctx.font = '40px sans-serif'
  ctx.fillText('Question 3.', 40, 80)
  ctx.fillText('A train travels 240 km in 3 hours.', 40, 160)
  ctx.fillText('At the same speed, how far in 5 hours?', 40, 230)
  const png = join(dir, '题目.png')
  writeFileSync(png, await canvas.encode('png'))
  await newChat()
  await pick([png])
  await ask('06-image-question', '帮我解这道题，写出步骤。')
})

test('音频转写后问答', async () => {
  test.setTimeout(900_000)
  const wav = join(dir, '会议录音.wav')
  copyFileSync(join(process.cwd(), 'e2e/fixtures/meeting.wav'), wav)
  await newChat()
  await pick([wav])
  await ask('07-audio', '这段录音里谁负责什么？列出行动项。')
})
