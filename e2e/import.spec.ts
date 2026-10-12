import { test, expect } from '@playwright/test'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { startSafetyApp, pickOpen, type SafetyApp } from './fixtures/safetyApp'
import { navTo } from './fixtures/nav'
import { makePdf } from './fixtures/makePdf'
import { createServer, type Server } from 'http'
import type { ImportOptions, ImportScan } from '../src/shared/importer'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import JSZip from 'jszip'
let env: SafetyApp
test.afterEach(async () => {
  await env?.close()
})
const shots = resolve('.superpowers/sdd/v0.11-update-sign-import/evidence/P4/shots')
async function entry(): Promise<void> {
  await env.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await navTo(env.page, /资料库/)
  await env.page.getByRole('button', { name: '导入笔记库', exact: true }).click({ timeout: 5000 })
}
async function choose(path: string): Promise<void> {
  await pickOpen(env, path)
  await env.page.getByTestId('import-wizard').getByRole('button', { name: '选择文件夹', exact: true }).click()
  await expect(env.page.getByTestId('import-tree')).toBeVisible()
}
test('Obsidian user import preserves structure, privacy, links and resources; duplicate ledger survives restart and undo restores', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-vault-'))
  cpSync(resolve('e2e/fixtures/import/obsidian-vault'), d, { recursive: true })
  mkdirSync(join(d, '附件'))
  writeFileSync(
    join(d, '附件/示意.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  )
  writeFileSync(join(d, '附件/材料.pdf'), makePdf([['Original fixture: learning by practice.']]))
  await entry()
  await choose(d)
  const wizard = env.page.getByTestId('import-wizard')
  await expect(wizard).toContainText('3 篇笔记')
  await expect(wizard).toContainText('2 个附件')
  await wizard.getByRole('checkbox', { name: '文件夹：略过' }).uncheck()
  await wizard.getByRole('button', { name: '预览：记忆与练习' }).click()
  await expect(wizard.getByTestId('import-preview')).toContainText('如何练习')
  await expect(wizard.getByTestId('import-preview').locator('table')).toBeVisible()
  mkdirSync(shots, { recursive: true })
  await env.page.screenshot({ path: join(shots, 'obsidian-preview-light.png') })
  await wizard.getByRole('button', { name: '下一步：导入选项' }).click()
  await wizard.getByRole('checkbox', { name: '导入的笔记标记为不给 AI' }).check()
  await wizard.getByRole('button', { name: '开始导入', exact: true }).click()
  await expect(wizard.getByTestId('import-result')).toBeVisible()
  await expect(wizard).toContainText('成功 2')
  await expect(wizard).toContainText('发现 2 个待办')
  const notes = await env.page.evaluate(() => window.jiwei.notes.list({}))
  const imported = notes.filter((n) => ['记忆与练习', '练习'].includes(n.title))
  expect(imported).toHaveLength(2)
  expect(imported.every((n) => n.aiExcluded)).toBe(true)
  const main = imported.find((n) => n.title === '记忆与练习')!,
    target = imported.find((n) => n.title === '练习')!
  expect((await env.page.evaluate((id) => window.jiwei.notes.get(id), main.id))?.createdAt).toBe(Date.UTC(2025, 0, 2))
  const tags = await env.page.evaluate(() => window.jiwei.tags.list())
  expect(tags.map((t) => t.name)).toEqual(expect.arrayContaining(['学习', 'a/b', '复习']))
  const sources = await env.page.evaluate(() => window.jiwei.sources.list({}))
  expect(sources.find((s) => s.originalName === '材料.pdf')?.aiExcluded).toBe(true)
  const search = await env.page.evaluate(() => window.jiwei.knowledge.search('记忆', { type: 'all' }, 30))
  expect(JSON.stringify(search)).not.toContain(main.id)
  const runId = await wizard.getByTestId('import-result').getAttribute('data-run-id')
  await wizard.getByRole('button', { name: '查看：记忆与练习' }).click()
  await expect(env.page.locator('.tiptap').first()).toContainText('如何练习')
  await expect(env.page.locator('.tiptap table')).toBeVisible()
  await expect(env.page.locator('.tiptap img[src^="jiwei://asset/"]')).toBeVisible()
  await expect
    .poll(() => env.page.locator('.tiptap img[src^="jiwei://asset/"]').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0)
  await expect(env.page.locator('.tiptap [data-kind="diagram"] svg.flowchart')).toBeVisible()
  await expect(env.page.locator('.tiptap .katex').first()).toBeVisible()
  await expect(env.page.getByRole('link', { name: '练习方法', exact: true })).toHaveAttribute('href', `jiwei://note/${target.id}`)
  await env.page.getByRole('link', { name: '练习方法', exact: true }).click()
  await expect(env.page.locator('.tiptap').first()).toContainText('用自己的话')
  const userData = env.userData
  await env.close()
  env = await startSafetyApp({ userData })
  await entry()
  await choose(d)
  await expect(env.page.getByTestId('import-wizard')).toContainText('已导入且未变')
  writeFileSync(join(d, '方法/练习.md'), '# 练习\n\n## 步骤\n源文件已经变化。')
  await env.page.getByTestId('import-wizard').getByRole('button', { name: '关闭', exact: true }).click()
  await entry()
  await choose(d)
  await expect(env.page.getByTestId('import-wizard')).toContainText('源文件有变化')
  await env.page.evaluate((id) => window.jiwei.importer.undo(id!), runId)
  const trash = await env.page.evaluate(() => window.jiwei.trash.list())
  expect(trash.map((x) => x.id)).toEqual(
    expect.arrayContaining([main.id, target.id, sources.find((s) => s.originalName === '材料.pdf')!.id])
  )
  await env.page.evaluate((id) => window.jiwei.trash.restore('note', id), main.id)
  expect((await env.page.evaluate((id) => window.jiwei.notes.get(id), main.id))?.deletedAt).toBeNull()
  const restoredScan = await scanAt(d)
  expect(restoredScan.entries.find((e) => e.path === '记忆.md')?.status).toBe('unchanged')
})
test('Markdown folder import renders a dark English result', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-markdown-'))
  cpSync(resolve('e2e/fixtures/import/markdown-folder'), d, { recursive: true })
  await entry()
  await choose(d)
  const wizard = env.page.getByTestId('import-wizard')
  await wizard.getByRole('button', { name: '下一步：导入选项' }).click()
  await wizard.getByRole('button', { name: '开始导入', exact: true }).click()
  await expect(wizard.getByTestId('import-result')).toBeVisible()
  await expect(wizard).toContainText('成功 2')
  await env.page.evaluate(() => window.jiwei.settings.set({ theme: 'dark', language: 'en' }))
  await env.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(600, 600)
    win.setSize(760, 900)
  })
  await expect.poll(() => env.page.evaluate(() => window.innerWidth)).toBe(760)
  await expect(wizard).toContainText('Import results')
  expect(await wizard.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await env.page.screenshot({ path: join(shots, 'markdown-result-dark-en.png') })
})

async function scanAt(path: string, mode: 'folder' | 'notion' | 'notion-folder' = 'folder'): Promise<ImportScan> {
  await pickOpen(env, path)
  const start = await env.page.evaluate((mode) => window.jiwei.importer.choose(mode), mode)
  expect(start).toBeTruthy()
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.importer.scan(id).then((s) => s.status), start!.id)).toBe('ready')
  return env.page.evaluate((id) => window.jiwei.importer.scan(id), start!.id)
}
const importOptions = (scan: ImportScan, extra: Partial<ImportOptions> = {}): ImportOptions => ({
  paths: scan.entries.map((e) => e.path),
  categoryId: null,
  newCategoryName: '导入：测试',
  preserveFolders: true,
  tags: true,
  aiExcluded: false,
  aiCues: false,
  importChanged: false,
  ...extra
})

test('Markdown file picker imports referenced local images and PDFs while leaving adjacent notes unselected', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-files-'))
  mkdirSync(join(d, '附件'))
  writeFileSync(join(d, 'A.md'), '# 文件选择样例\n\n![](附件/示意.png) [阅读材料](附件/材料.pdf) [根目录材料](材料.pdf)')
  writeFileSync(join(d, 'B.md'), '# 未选择的邻居')
  writeFileSync(
    join(d, '附件/示意.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  )
  writeFileSync(join(d, '附件/材料.pdf'), makePdf([['Original file-selection fixture.']]))
  writeFileSync(join(d, '材料.pdf'), makePdf([['Different root material in the file-selection fixture.']]))
  await entry()
  await pickOpen(env, join(d, 'A.md'))
  const wizard = env.page.getByTestId('import-wizard')
  await wizard.getByRole('button', { name: '选择 Markdown 文件', exact: true }).click()
  await expect(wizard.getByTestId('import-tree')).toBeVisible()
  await expect(wizard).toContainText('1 篇笔记')
  await expect(wizard).toContainText('3 个附件')
  await wizard.getByRole('button', { name: '预览：文件选择样例', exact: true }).click()
  await expect(wizard.getByTestId('import-preview').locator('img')).toBeVisible()
  await wizard.getByRole('button', { name: '下一步：导入选项' }).click()
  await wizard.getByRole('button', { name: '开始导入', exact: true }).click()
  await expect(wizard.getByTestId('import-result')).toBeVisible()
  expect((await env.page.evaluate(() => window.jiwei.notes.list({}))).some((n) => n.title === '未选择的邻居')).toBe(false)
  expect((await env.page.evaluate(() => window.jiwei.sources.list({}))).filter((s) => s.originalName === '材料.pdf')).toHaveLength(2)
  await wizard.getByRole('button', { name: '查看：文件选择样例', exact: true }).click()
  await expect(env.page.locator('.tiptap img[src^="jiwei://asset/"]')).toBeVisible()
  await expect(env.page.getByRole('link', { name: '阅读材料', exact: true })).toHaveAttribute('href', /^jiwei:\/\/source\//)
  const nested = await env.page.getByRole('link', { name: '阅读材料', exact: true }).getAttribute('href'),
    root = await env.page.getByRole('link', { name: '根目录材料', exact: true }).getAttribute('href')
  expect(root).toMatch(/^jiwei:\/\/source\//)
  expect(root).not.toBe(nested)
})

test('Notion ZIP and extracted folder create linked database tables, readable hierarchy and reversible notes', async () => {
  env = await startSafetyApp()
  await entry()
  await pickOpen(env, resolve('e2e/fixtures/import/notion-export.zip'))
  const wizard = env.page.getByTestId('import-wizard')
  await wizard.getByRole('button', { name: '选择 Notion ZIP', exact: true }).click({ timeout: 5000 })
  await expect(wizard.getByTestId('import-tree')).toBeVisible()
  await expect(wizard).toContainText('4 篇笔记')
  await wizard.getByRole('button', { name: '预览：阅读库', exact: true }).click()
  await expect(wizard.getByTestId('import-preview').locator('table')).toContainText('第二行含"引号"')
  const p5shots = resolve('.superpowers/sdd/v0.11-update-sign-import/evidence/P5/shots')
  mkdirSync(p5shots, { recursive: true })
  await env.page.screenshot({ path: join(p5shots, 'notion-light.png') })
  await wizard.getByRole('button', { name: '下一步：导入选项' }).click()
  await wizard.getByRole('button', { name: '开始导入', exact: true }).click()
  await expect(wizard.getByTestId('import-result')).toBeVisible()
  await expect(wizard).toContainText('成功 4')
  const runId = await wizard.getByTestId('import-result').getAttribute('data-run-id')
  const notes = await env.page.evaluate(() => window.jiwei.notes.list({}))
  expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining(['欢迎', '观察记录', '阅读库', '晨读']))
  const categories = await env.page.evaluate(() => window.jiwei.categories.list('note'))
  expect(categories.map((c) => c.name)).toEqual(expect.arrayContaining(['欢迎', '阅读库']))
  expect(categories.some((c) => /[a-f\d]{32}/i.test(c.name))).toBe(false)
  await wizard.getByRole('button', { name: '查看：阅读库', exact: true }).click()
  const morning = notes.find((n) => n.title === '晨读')!
  await expect(env.page.getByRole('link', { name: '晨读', exact: true })).toHaveAttribute('href', `jiwei://note/${morning.id}`)
  await env.page.getByRole('link', { name: '晨读', exact: true }).click()
  await expect(env.page.getByRole('textbox', { name: '笔记标题' })).toHaveValue('晨读')
  const repeated = await scanAt(resolve('e2e/fixtures/import/notion-export.zip'), 'notion')
  expect(repeated.entries.every((e) => e.status === 'unchanged')).toBe(true)
  await env.page.evaluate((id) => window.jiwei.importer.undo(id!), runId)
  const trash = await env.page.evaluate(() => window.jiwei.trash.list())
  expect(trash.filter((i) => notes.some((n) => n.id === i.id))).toHaveLength(4)
  const folder = mkdtempSync(join(tmpdir(), 'jiwei-notion-folder-'))
  cpSync(resolve('e2e/fixtures/import/notion-format'), folder, { recursive: true })
  const folderRun = await runImport(await scanAt(folder, 'notion-folder'))
  expect(folderRun.items.filter((i) => i.status === 'imported')).toHaveLength(4)
})

test('unsafe Notion ZIP is rejected with a readable reason and creates no notes', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-notion-unsafe-')),
    file = join(d, 'unsafe.zip')
  writeFileSync(file, await new JSZip().file('../escape.md', '# Escape').generateAsync({ type: 'nodebuffer' }))
  await entry()
  await pickOpen(env, file)
  const wizard = env.page.getByTestId('import-wizard')
  await wizard.getByRole('button', { name: '选择 Notion ZIP', exact: true }).click({ timeout: 5000 })
  await expect(wizard).toContainText('压缩包包含不安全的路径')
  expect(await env.page.evaluate(() => window.jiwei.notes.list({}))).toEqual([])
})
async function runImport(scan: ImportScan, extra: Partial<ImportOptions> = {}) {
  const result = await env.page.evaluate(({ id, options }) => window.jiwei.importer.start(id, options), {
    id: scan.id,
    options: importOptions(scan, extra)
  })
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.status), result.id)).toBe('done')
  return env.page.evaluate((id) => window.jiwei.importer.run(id), result.id)
}
test('changed sources create a new note only on request, and private attachment import preserves existing public sources on undo', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-privacy-'))
  writeFileSync(join(d, 'Note.md'), '# 私密示例\n\n![[资料.pdf]]\n\n原始正文。')
  writeFileSync(join(d, '资料.pdf'), makePdf([['Original authored attachment.']]))
  const publicSource = (await env.page.evaluate((path) => window.jiwei.sources.importPaths([path]), join(d, '资料.pdf'))).imported[0]
  const first = await runImport(await scanAt(d), { aiExcluded: true })
  expect(first.sourceIds).toHaveLength(1)
  expect(first.sourceIds[0]).not.toBe(publicSource.id)
  expect((await env.page.evaluate((id) => window.jiwei.sources.get(id), first.sourceIds[0]))?.aiExcluded).toBe(true)
  const originalId = first.items[0].noteId!
  writeFileSync(join(d, 'Note.md'), '# 私密示例\n\n新正文。')
  const scan = await scanAt(d)
  expect(scan.entries[0].status).toBe('changed')
  const skip = await runImport(scan)
  expect(skip.items[0].status).toBe('skipped')
  const second = await runImport(scan, { importChanged: true })
  expect(second.items[0].noteId).not.toBe(originalId)
  expect(JSON.stringify(await storedDoc(originalId))).toContain('原始正文')
  const publicHits = await env.page.evaluate(() => window.jiwei.knowledge.search('新正文', { type: 'all' }, 30))
  expect(publicHits.some((hit) => hit.parentId === second.items[0].noteId)).toBe(true)
  const privateHits = await env.page.evaluate(() => window.jiwei.knowledge.search('原始正文', { type: 'all' }, 30))
  expect(privateHits.some((hit) => hit.parentId === originalId)).toBe(false)
  await env.page.evaluate((id) => window.jiwei.importer.undo(id), first.id)
  expect((await env.page.evaluate((id) => window.jiwei.sources.get(id), publicSource.id))?.deletedAt).toBeNull()
  expect((await env.page.evaluate((id) => window.jiwei.sources.get(id), publicSource.id))?.aiExcluded).toBe(false)
})
test('cancellation stops writes and keeps finished notes reviewable with whole-import undo', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-cancel-'))
  for (let i = 0; i < 120; i++)
    writeFileSync(join(d, `${i.toString().padStart(3, '0')}.md`), `# 取消样例 ${i}\n\n${'原创段落。'.repeat(80)}`)
  const scan = await scanAt(d)
  const start = await env.page.evaluate(({ id, options }) => window.jiwei.importer.start(id, options), {
    id: scan.id,
    options: importOptions(scan)
  })
  await env.page.evaluate((id) => window.jiwei.importer.cancel(id), start.id)
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.status), start.id)).toBe('canceled')
  const stopped = await env.page.evaluate((id) => window.jiwei.importer.run(id), start.id)
  expect(stopped.items.filter((i) => i.status === 'imported').length).toBeLessThan(120)
  const ids = stopped.items.filter((i) => i.status === 'imported').map((i) => i.noteId!)
  await env.page.evaluate((id) => window.jiwei.importer.undo(id), start.id)
  const live = await env.page.evaluate(() => window.jiwei.notes.list({}))
  expect(live.some((n) => ids.includes(n.id))).toBe(false)
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.notes.list({}).then((n) => n.filter((x) => x.title.startsWith('取消样例')).length)))
    .toBe(0)
})
test('optional AI cues use metered proposals and block a note excluded before its queued job', async () => {
  env = await startSafetyApp()
  let requests = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      const input = JSON.parse(body) as { messages: { role: string; content: string }[] }
      if (input.messages.some((m) => m.role === 'system' && m.content.includes('Suggest one concise learning question'))) requests++
      const prompt = input.messages.find((m) => m.role === 'user')?.content ?? ''
      const blockIds = [...prompt.matchAll(/"blockId":"([^"]+)"/g)].map((m) => m[1])
      const args = { questions: blockIds.map((blockId) => ({ blockId, question: '为什么要用自己的话复述？' })) }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-4.1-mini',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'submit-1', type: 'function', function: { name: 'submit', arguments: JSON.stringify(args) } }]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }
        })
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    await env.page.evaluate(async (baseUrl) => {
      const provider = await window.jiwei.providers.save({
        kind: 'ollama',
        name: 'Import cue protocol fixture',
        baseUrl,
        models: ['gpt-4.1-mini']
      })
      const settings = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: provider.id, model: 'gpt-4.1-mini' }, effort: 'off' } })
    }, baseUrl)
    const d = mkdtempSync(join(tmpdir(), 'jiwei-import-cues-'))
    writeFileSync(join(d, '学习.md'), '# 学习\n\n用自己的话复述，再核对原文。')
    const scan = await scanAt(d)
    const estimate = await env.page.evaluate(({ id, paths }) => window.jiwei.importer.estimate(id, paths), {
      id: scan.id,
      paths: scan.entries.map((e) => e.path)
    })
    expect(estimate.calls).toBe(1)
    expect(estimate.cost).toBeGreaterThan(0)
    await entry()
    await choose(d)
    const wizard = env.page.getByTestId('import-wizard')
    await wizard.getByRole('button', { name: '下一步：导入选项' }).click()
    await wizard.getByRole('checkbox', { name: '用 AI 为导入的笔记补线索问题', exact: true }).check()
    await wizard.getByRole('button', { name: '开始导入', exact: true }).click()
    await expect(wizard.getByTestId('import-result')).toBeVisible()
    const id = await wizard.getByTestId('import-result').getAttribute('data-run-id')
    const result = await env.page.evaluate((id) => window.jiwei.importer.run(id!), id)
    expect(result.cueJobIds).toHaveLength(1)
    await env.page.evaluate((id) => window.jiwei.jobs.runNow(id), result.cueJobIds[0])
    const noteId = result.items[0].noteId!
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.proposals.list(id).then((p) => p.length), noteId)).toBe(1)
    expect(requests).toBe(1)
    expect((await env.page.evaluate((id) => window.jiwei.proposals.list(id), noteId))[0].ops[0]).toMatchObject({
      op: 'replace_block',
      nodes: [{ type: 'paragraph', content: [{ type: 'text', text: '为什么要用自己的话复述？' }] }]
    })
    expect(JSON.stringify(await storedDoc(noteId))).not.toContain('为什么')
    const usage = await env.page.evaluate(() => window.jiwei.usage.summary())
    expect(usage.byPurpose.find((p) => p.key === 'import.cues')?.calls).toBe(1)
    writeFileSync(join(d, '另一个.md'), '# 另一个\n\n待撤回的文本。')
    await wizard.getByRole('button', { name: '再导入一个', exact: true }).click()
    await choose(d)
    await wizard.getByRole('button', { name: '下一步：导入选项' }).click()
    await expect(wizard.getByRole('checkbox', { name: '用 AI 为导入的笔记补线索问题', exact: true })).not.toBeChecked()
    await wizard.getByRole('button', { name: '关闭', exact: true }).click()
    const next = await runImport(await scanAt(d), { aiCues: true })
    const privateId = next.items.find((i) => i.status === 'imported')!.noteId!
    await env.page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true }), privateId)
    await env.page.evaluate((id) => window.jiwei.jobs.runNow(id), next.cueJobIds[0])
    await expect
      .poll(() =>
        env.page.evaluate((id) => window.jiwei.jobs.list().then((jobs) => jobs.find((j) => j.id === id)?.status), next.cueJobIds[0])
      )
      .toBe('failed')
    expect(requests).toBe(1)
    expect(await env.page.evaluate((id) => window.jiwei.proposals.list(id), privateId)).toEqual([])
    await env.page.evaluate((id) => window.jiwei.importer.cancelCues(id), next.id)
    writeFileSync(join(d, '长笔记.md'), '# 长笔记\n\n' + Array.from({ length: 60 }, () => '字'.repeat(4000)).join('\n\n'))
    const longScan = await scanAt(d)
    const longEstimate = await env.page.evaluate(({ id, paths }) => window.jiwei.importer.estimate(id, paths), {
      id: longScan.id,
      paths: ['长笔记.md']
    })
    expect(longEstimate.calls).toBe(6)
    const longRun = await runImport(longScan, { aiCues: true })
    await env.page.evaluate((id) => window.jiwei.jobs.runNow(id), longRun.cueJobIds[0])
    const longId = longRun.items.find((i) => i.path === '长笔记.md')!.noteId!
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.proposals.list(id).then((p) => p.length), longId)).toBe(6)
    const proposals = await env.page.evaluate((id) => window.jiwei.proposals.list(id), longId)
    expect(new Set(proposals.flatMap((p) => p.ops.flatMap((o) => (o.op === 'replace_block' ? [o.blockId] : [])))).size).toBe(60)
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
  }
})

async function storedDoc(noteId: string) {
  const bytes = await env.page.evaluate(async (id) => Array.from(await window.jiwei.notes.loadDoc(id)), noteId)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(bytes))
  const json = yDocToProsemirrorJSON(doc, 'default')
  doc.destroy()
  return json
}

test('a process crash during import resumes from persisted checkpoints without creating duplicate notes', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-resume-'))
  for (let i = 0; i < 300; i++) writeFileSync(join(d, `${i}.md`), `# 恢复样例 ${i}\n\n${'保留原文。'.repeat(500)}`)
  const scan = await scanAt(d)
  const run = await env.page.evaluate(({ id, options }) => window.jiwei.importer.start(id, options), {
    id: scan.id,
    options: importOptions(scan)
  })
  const userData = env.userData
  await expect
    .poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.progress > 0 && r.progress < 1), run.id))
    .toBe(true)
  const process = env.app.process()
  process.kill('SIGKILL')
  await new Promise<void>((done) => process.once('exit', () => done()))
  await env.close().catch(() => {})
  env = await startSafetyApp({ userData })
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.status), run.id)).toBe('done')
  const completed = await env.page.evaluate((id) => window.jiwei.importer.run(id), run.id)
  expect(completed.items.filter((i) => i.status === 'imported')).toHaveLength(300)
  expect((await env.page.evaluate(() => window.jiwei.notes.list({}))).filter((n) => n.title.startsWith('恢复样例'))).toHaveLength(300)
  writeFileSync(
    resolve('.superpowers/sdd/v0.11-update-sign-import/evidence/P5/crash-shutdown-diagnostic.json'),
    JSON.stringify({ userData, jobs: await env.page.evaluate(() => window.jiwei.jobs.list()) }, null, 2)
  )
})

test('normal quit resumes a mixed unchanged and new import, preserves user edits and restores links to skipped notes', async () => {
  env = await startSafetyApp()
  const d = mkdtempSync(join(tmpdir(), 'jiwei-import-quit-'))
  writeFileSync(join(d, '0.md'), '# 已有目标\n\n先前导入的笔记。')
  const first = await scanAt(d)
  const earlier = await env.page.evaluate(({ id, options }) => window.jiwei.importer.start(id, options), {
    id: first.id,
    options: importOptions(first)
  })
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.status), earlier.id)).toBe('done')
  const old = (await env.page.evaluate((id) => window.jiwei.importer.run(id), earlier.id)).items[0].noteId!
  for (let i = 1; i <= 300; i++) writeFileSync(join(d, `${i}.md`), `# 退出续传 ${i}\n\n[[0|已有目标]]\n\n${'保留完整正文。'.repeat(500)}`)
  const scan = await scanAt(d)
  const run = await env.page.evaluate(({ id, options }) => window.jiwei.importer.start(id, options), {
    id: scan.id,
    options: importOptions(scan)
  })
  await expect
    .poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.progress > 0 && r.progress < 1), run.id))
    .toBe(true)
  const during = await env.page.evaluate(() => window.jiwei.notes.list({}))
  const live = during.filter((n) => n.title.startsWith('退出续传'))
  expect(live.length).toBeGreaterThan(0)
  expect(live.every((n) => n.wordCount > 0 && n.excerpt.includes('保留完整正文'))).toBe(true)
  const editing = live[0].id
  await env.page.evaluate((id) => window.jiwei.notes.update(id, { title: '用户编辑保留' }), editing)
  const userDoc = new Y.Doc()
  Y.applyUpdate(userDoc, new Uint8Array(await env.page.evaluate(async (id) => Array.from(await window.jiwei.notes.loadDoc(id)), editing)))
  const row = userDoc.getXmlFragment('default').toArray()[0] as Y.XmlElement,
    body = row.toArray()[1] as Y.XmlElement,
    paragraph = new Y.XmlElement('paragraph'),
    text = new Y.XmlText()
  text.insert(0, 'USER EDIT DURING IMPORT')
  paragraph.insert(0, [text])
  body.insert(body.length, [paragraph])
  await env.page.evaluate(({ id, bytes }) => window.jiwei.notes.pushUpdate(id, new Uint8Array(bytes)), {
    id: editing,
    bytes: [...Y.encodeStateAsUpdate(userDoc)]
  })
  userDoc.destroy()
  const userData = env.userData
  await env.close()
  env = await startSafetyApp({ userData })
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.importer.run(id).then((r) => r.status), run.id)).toBe('done')
  const completed = await env.page.evaluate((id) => window.jiwei.importer.run(id), run.id)
  expect(completed.items.filter((i) => i.status === 'imported')).toHaveLength(300)
  expect(completed.items.filter((i) => i.status === 'skipped')).toHaveLength(1)
  expect((await env.page.evaluate((id) => window.jiwei.notes.get(id), editing))?.title).toBe('用户编辑保留')
  expect(JSON.stringify(await storedDoc(editing))).toContain('USER EDIT DURING IMPORT')
  for (const item of completed.items.filter((i) => i.status === 'imported'))
    expect(JSON.stringify(await storedDoc(item.noteId!))).toContain(`jiwei://note/${old}`)
  await env.page.evaluate((id) => window.jiwei.importer.undo(id), run.id)
  expect((await env.page.evaluate((id) => window.jiwei.notes.get(id), old))?.deletedAt).toBeNull()
})
