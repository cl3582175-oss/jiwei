import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 生成类内容（不需要 API Key）：表格、图表、图示、时间线、代码分步讲解、交互演示的显示，以及 Mermaid 校验。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let noteId = ''
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-export-'))
process.env.JIWEI_EXPORT_DIR = exportDir
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-visuals-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('生成内容')
  await page.keyboard.press('Enter')
  await page.keyboard.type('开头')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '生成内容' }).then((n) => n.length))).toBeGreaterThan(0)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '生成内容' }).then((n) => n[0].id))
})
test.afterAll(async () => {
  await app?.close()
})

const row = (kind: string, id: string) => ({
  op: 'insert_row' as const,
  afterRowId: null,
  cue: [],
  body: [{ type: 'embed', attrs: { id, kind } }]
})

test('all visual kinds render after accepting a proposal (live previews first)', async () => {
  await page.evaluate(
    ({ noteId, ops }) =>
      window.jiwei.proposals.create({
        noteId,
        title: '生成内容',
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [],
            body: [
              {
                type: 'table',
                content: [
                  {
                    type: 'tableRow',
                    content: [
                      { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '方法' }] }] },
                      { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '作用' }] }] }
                    ]
                  },
                  {
                    type: 'tableRow',
                    content: [
                      { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '间隔重复' }] }] },
                      { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '对抗遗忘' }] }] }
                    ]
                  }
                ]
              }
            ]
          },
          ...ops
        ],
        embeds: {
          c: {
            kind: 'chart',
            data: {
              type: 'line',
              title: '遗忘曲线',
              categories: ['20 分钟', '1 天', '6 天'],
              series: [{ name: '保持率', data: [58, 34, 25] }],
              yLabel: '%'
            }
          },
          d: { kind: 'diagram', data: { code: 'flowchart TD\n  A[学习] --> B{记得吗？}\n  B -- 忘了 --> C[复习]\n  C --> B' } },
          t: {
            kind: 'timeline',
            data: {
              title: '遗忘研究',
              events: [
                { date: '1885 年', title: '艾宾浩斯发表遗忘曲线' },
                { date: '1932 年', title: '巴特利特：记忆是重构' },
                { date: '2006 年', title: '测试效应研究' }
              ]
            }
          },
          s: {
            kind: 'steps',
            data: {
              language: 'python',
              code: 'total = 0\nfor i in range(3):\n    total += i\nprint(total)',
              steps: [
                { lines: [1], note: '初始化', vars: { total: '0' } },
                { lines: [2, 3], note: '第一次循环', vars: { i: '0', total: '0' } },
                { lines: [4], note: '输出 3' }
              ]
            }
          },
          x: {
            kind: 'interactive',
            data: {
              title: '滑块演示',
              height: 200,
              html: '<label>间隔 <input id="r" type="range" min="1" max="10" value="3"></label> <b id="v">3</b> 天<p id="net">?</p><p id="parent">?</p><script>r.oninput=()=>v.textContent=r.value;fetch("https://example.com").then(()=>net.textContent="leak",()=>net.textContent="blocked");try{parent.document.title;window.parent.textContent="leak"}catch(e){document.getElementById("parent").textContent="isolated"}</script>'
            }
          }
        }
      }),
    { noteId, ops: [row('chart', 'c'), row('diagram', 'd'), row('timeline', 't'), row('steps', 's'), row('interactive', 'x')] }
  )
  // 提案面板中直接用真实组件预览
  await expect(page.locator('.proposal-embed-live .chart-canvas svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.proposal-embed-live .diagram-svg svg').first()).toBeVisible({ timeout: 15_000 })
  if (shots) await page.screenshot({ path: join(shots, '101-visual-proposals.png'), fullPage: true })
  await page.getByRole('button', { name: '全部接受' }).click()

  const doc = page.locator('.cornell-doc')
  await expect(doc.locator('table th').first()).toHaveText('方法')
  await expect(doc.locator('.embed-block[data-kind="chart"] .chart-canvas svg')).toBeVisible({ timeout: 15_000 })
  await expect(doc.locator('.embed-block[data-kind="diagram"] .diagram-svg svg')).toContainText('记得吗？', { timeout: 15_000 })
  await expect(doc.locator('.timeline-item')).toHaveCount(3)
  // 代码分步讲解：下一步
  const steps = doc.locator('.embed-block[data-kind="steps"]')
  await expect(steps.locator('.steps-line.is-on')).toHaveCount(1)
  await steps.getByRole('button', { name: '下一步' }).click()
  await expect(steps.locator('.steps-line.is-on')).toHaveCount(2)
  await expect(steps).toContainText('第 2 步 / 共 3 步')
  // 交互演示在沙箱中运行
  const frame = page.frameLocator('.embed-block[data-kind="interactive"] iframe')
  await frame.locator('#r').fill('7')
  await expect(frame.locator('#v')).toHaveText('7')
  await expect(page.locator('.embed-block[data-kind="interactive"] iframe')).toHaveAttribute('sandbox', 'allow-scripts')
  // 安全：不能联网、不能访问应用页面
  await expect(frame.locator('#net')).toHaveText('blocked')
  await expect(frame.locator('#parent')).toHaveText('isolated')
  if (shots) {
    await doc.locator('.embed-block[data-kind="chart"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(shots, '102-visuals.png') })
    await doc.locator('.embed-block[data-kind="steps"]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, '103-visuals-2.png') })
  }
  // 进入检索文本
  await expect.poll(async () => JSON.stringify(await page.evaluate((id) => window.jiwei.notes.blocks(id), noteId))).toContain('巴特利特')
})

test('函数图滑块与几何图拖动（JSXGraph），非法表达式被拒', async () => {
  const graphs = {
    g1: {
      kind: 'graph',
      data: {
        title: '二次函数平移',
        graph: {
          type: 'function',
          functions: [{ expr: 'a(x-h)^2', label: 'y = a(x-h)²' }],
          params: [
            { name: 'a', min: -2, max: 2, value: 1 },
            { name: 'h', min: -3, max: 3, value: 0 }
          ],
          view: [-5, 5, -4, 6]
        }
      }
    },
    g2: {
      kind: 'graph',
      data: {
        title: '三角形的高',
        graph: {
          type: 'geometry',
          elements: [
            { type: 'point', id: 'A', x: -3, y: -1 },
            { type: 'point', id: 'B', x: 3, y: -1 },
            { type: 'point', id: 'C', x: 0, y: 2.5 },
            { type: 'polygon', id: 'T', points: ['A', 'B', 'C'] },
            { type: 'segment', id: 'AB', from: 'A', to: 'B' },
            { type: 'perpendicular', id: 'h', line: 'AB', through: 'C' }
          ]
        }
      }
    }
  }
  await page.evaluate(
    ({ noteId, ops, embeds }) => window.jiwei.proposals.create({ noteId, title: '数学图', ops, embeds }),
    { noteId, ops: [row('graph', 'g1'), row('graph', 'g2')], embeds: graphs }
  )
  await page.getByRole('button', { name: '全部接受' }).click()
  const doc = page.locator('.cornell-doc')
  const fn = doc.locator('.embed-block[data-kind="graph"]').filter({ hasText: '二次函数平移' })
  const geo = doc.locator('.embed-block[data-kind="graph"]').filter({ hasText: '三角形的高' })
  await expect(fn.locator('.jxgbox svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(geo.locator('.jxgbox svg').first()).toBeVisible({ timeout: 15_000 })
  await expect(fn).toContainText('拖动滑块')
  await expect(geo).toContainText('拖动点')
  // 拖动滑块：函数曲线的路径随参数改变
  await fn.scrollIntoViewIfNeeded()
  if (shots) await page.screenshot({ path: join(shots, '104a-graphs.png') })
  const curve = (): Promise<string> => fn.locator('.jxgbox svg path').evaluateAll((ps) => ps.map((p) => p.getAttribute('d') ?? '').sort((a, b) => b.length - a.length)[0])
  const before = await curve()
  // 参数滑块在图下方（原生 range，可键盘操作）
  await fn.getByRole('slider', { name: 'a' }).fill('2')
  await expect(fn.getByTestId('graph-params')).toContainText('a = 2')
  await expect.poll(curve).not.toBe(before)
  if (shots) {
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shots, '104-graphs.png') })
    await geo.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shots, '105-geometry.png') })
  }
  // 检索文本包含表达式
  await expect.poll(async () => JSON.stringify(await page.evaluate((id) => window.jiwei.notes.blocks(id), noteId))).toContain('a(x-h)^2')
  // 非法表达式在注册表层被拒（不会以“内容缺失”的块写入笔记）
  const bad = await page
    .evaluate(
      ({ noteId, ops, embeds }) => window.jiwei.proposals.create({ noteId, title: '坏图', ops, embeds }).then(() => 'stored', (e) => String(e)),
      { noteId, ops: [row('graph', 'bad')], embeds: { bad: { kind: 'graph', data: { graph: { type: 'function', functions: [{ expr: 'alert(1)' }] } } } } }
    )
  expect(bad).not.toBe('stored')
})

test('Mermaid validation reports syntax errors back to the model', async () => {
  const ok = await page.evaluate(() => window.__jiweiValidate!('diagram', { code: 'flowchart TD\n  A[学] --> B[习]' }))
  expect(ok).toBeNull()
  const bad = await page.evaluate(() => window.__jiweiValidate!('diagram', { code: 'flowchart TD\n  A[学 --> ((' }))
  expect(bad).toBeTruthy()
})

test('export: Markdown (with image folder), HTML, PDF, Word', async () => {
  test.setTimeout(120_000)
  const { readFileSync, readdirSync, existsSync } = await import('fs')
  const dir = process.env.JIWEI_EXPORT_DIR!
  const label = { md: /Markdown/, html: /网页/, pdf: /^PDF$/, docx: /Word/ }
  for (const f of ['md', 'html', 'pdf', 'docx'] as const) {
    await page.getByRole('button', { name: '更多' }).click()
    await page.getByRole('menuitem', { name: '导出' }).focus()
    await page.keyboard.press('ArrowRight')
    const item = page.getByRole('menuitem', { name: label[f] })
    await item.focus()
    await expect(item).toBeFocused()
    await page.keyboard.press('Enter')
    await expect.poll(() => existsSync(join(dir, `生成内容.${f}`)), { timeout: 30_000 }).toBe(true)
  }
  const md = readFileSync(join(dir, '生成内容.md'), 'utf8')
  expect(md).toContain('# 生成内容')
  expect(md).toContain('| 方法 | 作用 |')
  expect(md).toContain('```mermaid')
  expect(md).toContain('1885 年')
  expect(md).toMatch(/!\[chart\]\(生成内容\.assets\/chart-.+\.png\)/)
  expect(readdirSync(join(dir, '生成内容.assets')).some((n) => n.startsWith('chart-'))).toBe(true)
  const html = readFileSync(join(dir, '生成内容.html'), 'utf8')
  expect(html).toContain('<svg')
  expect(html).toContain('class="row"')
  expect(readFileSync(join(dir, '生成内容.pdf')).subarray(0, 4).toString()).toBe('%PDF')
  expect(readFileSync(join(dir, '生成内容.docx')).subarray(0, 2).toString()).toBe('PK')
})
