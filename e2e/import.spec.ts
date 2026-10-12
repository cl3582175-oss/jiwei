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

async function scanAt(path: string): Promise<ImportScan> {
  await pickOpen(env, path)
  const start = await env.page.evaluate(() => window.jiwei.importer.choose('folder'))
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
    const result = await runImport(scan, { aiCues: true })
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
})
