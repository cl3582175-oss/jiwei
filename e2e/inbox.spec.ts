import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { InboxSuggestion } from '../src/shared/inbox'
import { scanImage } from './fixtures/makeScanPdf'

test.describe.configure({ mode: 'serial' })
const userData = mkdtempSync(join(tmpdir(), 'jiwei-inbox-'))
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-inbox-export-'))
let app: ElectronApplication
let page: Page
async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())).toEqual(size)
  }
  await page.waitForSelector('nav')
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ capture: { ...s.capture, daily: false } })
  })
  await page.keyboard.press('ControlOrMeta+0')
  await expect(page.getByTestId('inbox-view')).toBeVisible()
}
test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})
async function capture(text: string) {
  return page.evaluate((text) => window.jiwei.inbox.create({ kind: 'text', text, origin: { app: 'Inbox E2E' } }), text)
}
async function markdown(noteId: string): Promise<string> {
  return readFileSync((await page.evaluate((id) => window.jiwei.notes.export(id, 'md', {}), noteId))!, 'utf8')
}
async function suggestion(id: string, value: InboxSuggestion): Promise<void> {
  // 确定性建议只验证归档路径；真实服务商语义由条件测试另行验收。
  await app.evaluate(
    ({ app }, { id, value }) => {
      const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
      try {
        db.prepare("UPDATE inbox_items SET suggestion = ?, status = 'suggested' WHERE id = ?").run(JSON.stringify(value), id)
      } finally {
        db.close()
      }
    },
    { id, value }
  )
}
async function refresh(): Promise<void> {
  await page.reload()
  await page.waitForSelector('nav')
  await page.keyboard.press('ControlOrMeta+0')
}

test('real text/image/file captures, badge, no-model guidance, deletion recovery and narrow layout', async () => {
  const text = await capture('文字捕捉入口证据')
  const image = await page.evaluate(
    (bytes) => window.jiwei.assets.importBytes('phone.jpg', 'image/jpeg', new Uint8Array(bytes)),
    [...scanImage(['保留原图'])]
  )
  const file = await page.evaluate(() =>
    window.jiwei.assets.importBytes('capture.md', 'text/markdown', new TextEncoder().encode('文件捕捉原文'))
  )
  const ids = await page.evaluate(
    async ({ image, file }) => [
      await window.jiwei.inbox.create({ kind: 'photo', assetId: image.id, origin: { device: 'phone', sessionId: 'test-phone' } }),
      await window.jiwei.inbox.create({ kind: 'file', assetId: file.id, origin: {} })
    ],
    { image, file }
  )
  for (const i of [text, ...ids]) await expect(page.getByTestId(`inbox-${i.id}`)).toBeVisible()
  await expect(page.locator('nav').getByRole('button', { name: /收件箱/ })).toContainText('3')
  await expect(page.getByRole('button', { name: '整理收件箱', exact: true })).toHaveAttribute('title', /设置.*模型/)
  await page.getByTestId(`inbox-${text.id}`).getByRole('button', { name: '删除捕捉' }).click()
  await expect(page.getByTestId(`inbox-${text.id}`)).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByTestId(`inbox-${text.id}`)).toBeVisible()
  expect(await page.getByTestId('inbox-view').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
  await page.screenshot({
    path: `${process.env.SHOTS_DIR || '.superpowers/sdd/2026-10-09-capture/task-2-evidence'}/inbox-${process.env.JIWEI_TEST_WINDOW || 'default'}.png`
  })
  await page.getByTestId(`inbox-${text.id}`).getByRole('combobox').selectOption('new_note')
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), text.id)).toBe('filed')
  const item = (await page.evaluate((id) => window.jiwei.inbox.get(id), text.id))!
  expect(await markdown(item.filedTo!.noteId!)).toContain('文字捕捉入口证据')
  expect(await markdown(item.filedTo!.noteId!)).toContain('来自收件箱')
  await page.getByRole('checkbox').check()
  await page.getByTestId(`inbox-${text.id}`).getByRole('button', { name: '打开笔记（可撤销）' }).click()
  await expect(page.locator('.cornell-body')).toContainText(['文字捕捉入口证据'])
  await page.locator('.cornell-body p').first().click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cornell-body')).not.toContainText(['文字捕捉入口证据'])
  await expect.poll(() => markdown(item.filedTo!.noteId!)).not.toContain('来自收件箱')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.cornell-body')).toContainText(['文字捕捉入口证据'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cornell-body')).not.toContainText(['文字捕捉入口证据'])
  await page.keyboard.press('ControlOrMeta+0')
  await page.getByRole('checkbox').uncheck()
  // 图片和文件通过真实资料导入服务归档。
  for (const i of ids) {
    await page.getByTestId(`inbox-${i.id}`).getByRole('combobox').selectOption('save_source')
    await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), i.id)).toBe('filed')
    const filed = await page.evaluate((id) => window.jiwei.inbox.get(id), i.id)
    expect(filed?.filedTo?.sourceIds).toHaveLength(1)
  }
})

test('concurrent acceptance and failed completion retry persist one proposal with original content', async () => {
  const i = await capture('并发重试只写一次')
  const results = await page.evaluate(
    (id) => Promise.all([window.jiwei.inbox.accept(id, { action: 'new_note' }), window.jiwei.inbox.accept(id, { action: 'new_note' })]),
    i.id
  )
  expect(results[0].filedTo).toEqual(results[1].filedTo)
  expect(results[0].status).toBe('new')
  expect(await markdown(results[0].filedTo!.noteId!)).not.toContain('来自收件箱')
  const rejected = await page.evaluate(async (id) => {
    try {
      await window.jiwei.inbox.complete(id, new Uint8Array([0, 0]))
      return false
    } catch {
      return true
    }
  }, results[0].filedTo!.proposalId!)
  expect(rejected).toBe(true)
  await page.getByTestId(`inbox-${i.id}`).getByRole('button', { name: '继续归档' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), i.id)).toBe('filed')
  expect((await markdown(results[0].filedTo!.noteId!)).split('来自收件箱')).toHaveLength(2)
})

test('non-leading grouped acceptance then accept-all preserves originals and files multiple notes across restart', async () => {
  const a = await capture('分组原文甲'),
    b = await capture('分组原文乙'),
    c = await capture('另一篇原文'),
    untouched = await capture('没有建议必须保留')
  await suggestion(a.id, { type: 'board', action: 'new_note', newNoteTitle: '同一组目的笔记', reason: '关联', groupWith: [b.id] })
  await suggestion(b.id, { type: 'board', action: 'new_note', newNoteTitle: '同一组目的笔记', reason: '关联', groupWith: [a.id] })
  await suggestion(c.id, { type: 'idea', action: 'new_note', newNoteTitle: '不同目的笔记', reason: '独立' })
  await refresh()
  await page.getByTestId(`inbox-${b.id}`).getByRole('button', { name: '接受建议' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), b.id)).toBe('filed')
  await page.getByRole('button', { name: '全部接受', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), c.id)).toBe('filed')
  await app.close()
  await launch()
  const rows = await page.evaluate((ids) => Promise.all(ids.map((id) => window.jiwei.inbox.get(id))), [a.id, b.id, c.id, untouched.id])
  expect(rows[0]!.filedTo!.noteId).toBe(rows[1]!.filedTo!.noteId)
  expect(rows[2]!.filedTo!.noteId).not.toBe(rows[0]!.filedTo!.noteId)
  expect(rows[3]!.status).toBe('new')
  const md = await markdown(rows[0]!.filedTo!.noteId!)
  expect(md.split(a.text)).toHaveLength(2)
  expect(md.split(b.text)).toHaveLength(2)
  expect(await markdown(rows[2]!.filedTo!.noteId!)).toContain(c.text)
})

test('text and URL sources and action suggestions use existing persistent services', async () => {
  const text = await capture('Markdown 资料持久化')
  const url = await page.evaluate(() =>
    window.jiwei.inbox.create({ kind: 'clip', text: '网址资料', origin: { url: 'https://example.com/' } })
  )
  const action = await capture('后续行动证据')
  await suggestion(action.id, { type: 'todo', action: 'action_item', actionTitle: '后续行动证据', dueAt: '2026-10-10', reason: '待办' })
  await refresh()
  for (const i of [text, url]) await page.getByTestId(`inbox-${i.id}`).getByRole('combobox').selectOption('save_source')
  await page.getByTestId(`inbox-${action.id}`).getByRole('button', { name: '接受建议' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), action.id)).toBe('filed')
  const items = await page.evaluate((ids) => Promise.all(ids.map((id) => window.jiwei.inbox.get(id))), [text.id, url.id, action.id])
  expect(items[0]?.filedTo?.sourceIds).toHaveLength(1)
  expect(items[1]?.filedTo?.sourceIds).toHaveLength(1)
  expect(items[2]?.filedTo?.actionId).toBeTruthy()
  const persisted = await app.evaluate(
    ({ app }, ids) => {
      const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'), { readonly: true })
      try {
        return {
          sources: ids.sources.map((id) => db.prepare('SELECT kind, url, asset_id FROM sources WHERE id = ?').get(id)),
          action: db.prepare('SELECT title, due_at FROM actions WHERE id = ?').get(ids.action)
        }
      } finally {
        db.close()
      }
    },
    { sources: [items[0]!.filedTo!.sourceIds![0], items[1]!.filedTo!.sourceIds![0]], action: items[2]!.filedTo!.actionId! }
  )
  expect(persisted.sources[0]).toMatchObject({ kind: 'document', asset_id: expect.any(String) })
  expect(persisted.sources[1]).toMatchObject({ kind: 'web', url: 'https://example.com/' })
  expect(persisted.action).toMatchObject({ title: '后续行动证据', due_at: new Date('2026-10-10T12:00:00').getTime() })
})

test('image note filing preserves original and mounted proposal application remains idempotent', async () => {
  const asset = await page.evaluate(
    (bytes) => window.jiwei.assets.importBytes('note.jpg', 'image/jpeg', new Uint8Array(bytes)),
    [...scanImage(['图片写入笔记'])]
  )
  const i = await page.evaluate(
    (assetId) => window.jiwei.inbox.create({ kind: 'photo', text: '原图归档证据', assetId, origin: { device: 'phone' } }),
    asset.id
  )
  await page.getByTestId(`inbox-${i.id}`).getByRole('combobox').selectOption('new_note')
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), i.id)).toBe('filed')
  const filed = (await page.evaluate((id) => window.jiwei.inbox.get(id), i.id))!
  expect(await markdown(filed.filedTo!.noteId!)).toContain(asset.id.slice(0, 12))
  await page.getByRole('checkbox').check()
  await page.getByTestId(`inbox-${i.id}`).getByRole('button', { name: '打开笔记（可撤销）' }).click()
  await expect(page.locator(`[data-image-block] img[src="${asset.url}"]`)).toBeVisible()
  const next = await capture('当前已打开笔记的追加原文')
  await page.evaluate(({ id, noteId }) => window.jiwei.inbox.accept(id, { action: 'append_note', noteId }), {
    id: next.id,
    noteId: filed.filedTo!.noteId!
  })
  await expect(page.locator('.cornell-body')).toContainText(['当前已打开笔记的追加原文'])
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), next.id)).toBe('filed')
  await page.evaluate((id) => window.jiwei.inbox.accept(id, { action: 'new_note' }), next.id)
  expect((await markdown(filed.filedTo!.noteId!)).split(next.text)).toHaveLength(2)
  await page.keyboard.press('ControlOrMeta+0')
})

test('interrupted grouped source import resumes checkpoint without duplicating earlier sources', async () => {
  const first = await capture('分组资料恢复原文')
  const bytes = [...Buffer.from('第二份资料的唯一原文')]
  const asset = await page.evaluate((bytes) => window.jiwei.assets.importBytes('resume.md', 'text/markdown', new Uint8Array(bytes)), bytes)
  const second = await page.evaluate((assetId) => window.jiwei.inbox.create({ kind: 'file', assetId, origin: {} }), asset.id)
  await suggestion(first.id, { type: 'article', action: 'save_source', reason: '一起归档', groupWith: [second.id] })
  await suggestion(second.id, { type: 'article', action: 'save_source', reason: '一起归档', groupWith: [first.id] })
  await app.evaluate(({ app }, id) => {
    const path = process.getBuiltinModule('path').join(app.getPath('userData'), 'data/assets', id.slice(0, 2), id.slice(2, 4), `${id}.md`)
    process.getBuiltinModule('fs').unlinkSync(path)
  }, asset.id)
  await refresh()
  await page.getByTestId(`inbox-${second.id}`).getByRole('button', { name: '接受建议' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.filedTo?.sourceIds?.length), first.id)).toBe(1)
  const checkpoint = (await page.evaluate((id) => window.jiwei.inbox.get(id), first.id))!
  expect(checkpoint.status).toBe('suggested')
  await page.evaluate((bytes) => window.jiwei.assets.importBytes('resume.md', 'text/markdown', new Uint8Array(bytes)), bytes)
  await page.getByTestId(`inbox-${first.id}`).getByRole('button', { name: '继续归档' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), first.id)).toBe('filed')
  const done = (await page.evaluate((id) => window.jiwei.inbox.get(id), second.id))!
  expect(done.filedTo!.sourceIds).toHaveLength(2)
  expect(done.filedTo!.sourceIds![0]).toBe(checkpoint.filedTo!.sourceIds![0])
})

test('queued OCR cancellation is persistent, retains originals, supports explicit retry and manual filing', async () => {
  const i = await capture('取消识别后原文仍可手工归档')
  const asset = await page.evaluate(
    (bytes) => window.jiwei.assets.importBytes('cancel.png', 'image/png', new Uint8Array(bytes)),
    [...scanImage(['保留取消后的原图'])]
  )
  // 在隔离数据库注入未来才到期的真实任务，确定性覆盖 handler 尚未执行的 queued 取消。
  const jobId = await app.evaluate(
    ({ app }, { id, assetId }) => {
      const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
      const jobId = process.getBuiltinModule('crypto').randomUUID(),
        now = Date.now()
      try {
        db.prepare("UPDATE inbox_items SET asset_id = ?, kind = 'photo', recognition_status = 'pending' WHERE id = ?").run(assetId, id)
        db.prepare(
          "INSERT INTO jobs(id,kind,payload,status,dedupe_key,run_after,created_at,updated_at) VALUES (?,'inbox.recognize',?,'queued',?,?,?,?)"
        ).run(jobId, JSON.stringify({ id }), `inbox.recognize:${id}`, now + 3_600_000, now, now)
        return jobId
      } finally {
        db.close()
      }
    },
    { id: i.id, assetId: asset.id }
  )
  await refresh()
  await page.evaluate((id) => window.jiwei.jobs.cancel(id), jobId)
  await expect(page.getByTestId(`inbox-${i.id}`)).toContainText('已取消识别，原件已保留')
  expect((await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === jobId)?.status).toBe('canceled')
  await app.close()
  await launch()
  expect((await page.evaluate((id) => window.jiwei.inbox.get(id), i.id))?.recognitionStatus).toBe('canceled')
  expect((await page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.key === `inbox.recognize:${i.id}`)).toHaveLength(1)
  await page.getByRole('button', { name: '后台任务', exact: true }).click()
  // 取消项的任务面板中提供真实重试入口，不把它显示为成功勾选。
  const retry = page.getByRole('button', { name: '重试', exact: true })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.recognitionStatus), i.id)).not.toBe('canceled')
  await page.keyboard.press('Escape')
  await page.getByTestId(`inbox-${i.id}`).getByRole('combobox').selectOption('new_note')
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), i.id)).toBe('filed')
  const done = (await page.evaluate((id) => window.jiwei.inbox.get(id), i.id))!
  const content = await markdown(done.filedTo!.noteId!)
  expect(content).toContain(i.text)
  expect(content).toContain(asset.id.slice(0, 12))
})

test('item OCR retry survives 205 newer jobs and pruned history without duplicate attempts', async () => {
  test.setTimeout(90_000)
  // 此用例验证持久恢复状态机；真实本地识别语义由独立 OCR 用例验证。
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'off', auto: false, figures: false, providerId: null, model: null } }
    })
  })
  const i = await capture('取消识别后原文仍可手工归档')
  const asset = await page.evaluate(
    (bytes) => window.jiwei.assets.importBytes('cancel.png', 'image/png', new Uint8Array(bytes)),
    [...scanImage(['保留取消后的原图'])]
  )
  // 在隔离数据库注入未来才到期的真实任务，确定性覆盖 handler 尚未执行的 queued 取消。
  const jobId = await app.evaluate(
    ({ app }, { id, assetId }) => {
      const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
      const jobId = process.getBuiltinModule('crypto').randomUUID(),
        now = Date.now()
      try {
        db.prepare("UPDATE inbox_items SET asset_id = ?, kind = 'photo', recognition_status = 'pending' WHERE id = ?").run(assetId, id)
        db.prepare(
          "INSERT INTO jobs(id,kind,payload,status,dedupe_key,run_after,created_at,updated_at) VALUES (?,'inbox.recognize',?,'queued',?,?,?,?)"
        ).run(jobId, JSON.stringify({ id }), `inbox.recognize:${id}`, now + 3_600_000, now, now)
        return jobId
      } finally {
        db.close()
      }
    },
    { id: i.id, assetId: asset.id }
  )
  await refresh()
  await page.evaluate((id) => window.jiwei.jobs.cancel(id), jobId)
  await expect(page.getByTestId(`inbox-${i.id}`)).toContainText('已取消识别，原件已保留')
  expect((await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === jobId)?.status).toBe('canceled')
  await app.evaluate(({ app }, jobId) => {
    const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
    try {
      const now = Date.now() + 1000
      const insert = db.prepare(
        "INSERT INTO jobs(id,kind,payload,status,run_after,created_at,updated_at) VALUES (?,'test.history','{}','done',?,?,?)"
      )
      for (let n = 0; n < 205; n++) insert.run(process.getBuiltinModule('crypto').randomUUID(), now, now + n, now + n)
      if ((db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string }).status !== 'canceled')
        throw new Error('Expected canceled job')
    } finally {
      db.close()
    }
  }, jobId)
  expect((await page.evaluate(() => window.jiwei.jobs.list())).some((j) => j.id === jobId)).toBe(false)
  const card = page.getByTestId(`inbox-${i.id}`)
  await card.getByRole('button', { name: '重新识别', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.recognitionStatus), i.id)).not.toBe('canceled')
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.recognitionStatus), i.id), { timeout: 30_000 })
    .toBe('unavailable')
  await app.evaluate(
    ({ app }, { id, jobId }) => {
      const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
      try {
        db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
        db.prepare("UPDATE inbox_items SET recognition_status = 'canceled' WHERE id = ?").run(id)
      } finally {
        db.close()
      }
    },
    { id: i.id, jobId }
  )
  await refresh()
  await expect(card.getByRole('button', { name: '重新识别', exact: true })).toBeVisible()
  const attempts = await page.evaluate(
    (id) => Promise.all([window.jiwei.inbox.retryRecognition(id), window.jiwei.inbox.retryRecognition(id)]),
    i.id
  )
  expect(attempts[0]).toBe(attempts[1])
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.recognitionStatus), i.id), { timeout: 30_000 })
    .toBe('unavailable')
  const preserved = (await page.evaluate((id) => window.jiwei.inbox.get(id), i.id))!
  expect(preserved).toMatchObject({ assetId: asset.id, text: i.text })
  await card.getByRole('combobox').selectOption('new_note')
  await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), i.id)).toBe('filed')
  const done = (await page.evaluate((id) => window.jiwei.inbox.get(id), i.id))!
  const content = await markdown(done.filedTo!.noteId!)
  expect(content).toContain(i.text)
  expect(content).toContain(asset.id.slice(0, 12))
  await page.evaluate((id) => window.jiwei.inbox.remove(id), i.id)
  await expect(page.evaluate((id) => window.jiwei.inbox.retryRecognition(id), i.id)).rejects.toThrow('原图片不存在或条目已删除')
  expect((await page.evaluate((id) => window.jiwei.inbox.get(id), i.id))?.deletedAt).toBeTruthy()
})

test('real provider organizes relevant text and a captioned classroom photo, then persists accepted note', async () => {
  test.skip(!process.env.JIWEI_IMPORT_PROVIDERS_FROM, '需要真实服务商配置；不读取用户凭证或模拟模型回复')
  test.setTimeout(600_000)
  await app.close()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-inbox-provider-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ capture: { ...s.capture, daily: false } })
  })
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('间隔重复与提取练习')
  await page.keyboard.press('Enter')
  await page.keyboard.type('学习后先合上书主动回忆，隔一天、三天、七天重复复习。间隔重复与提取练习能增强长期记忆。')
  let noteId = ''
  await expect
    .poll(
      async () =>
        (noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '间隔重复与提取练习' }).then((n) => n[0]?.id ?? '')))
    )
    .not.toBe('')
  await expect.poll(() => markdown(noteId)).toContain('增强长期记忆')
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  await expect
    .poll(
      async () => {
        const status = await page.evaluate(() => window.jiwei.embedding.status())
        return status.total > 0 && status.indexed === status.total
      },
      { timeout: 240_000 }
    )
    .toBe(true)
  const text = await capture('关于间隔重复和提取练习的新笔记：先主动回忆，然后在一天、三天、七天后自测复习。请保留这个学习方法。')
  const image = await page.evaluate(
    (bytes) => window.jiwei.assets.importBytes('classroom.jpg', 'image/jpeg', new Uint8Array(bytes)),
    [...scanImage(['课堂板书：间隔重复', '一天、三天、七天后自测复习'])]
  )
  const photo = await page.evaluate(
    (assetId) =>
      window.jiwei.inbox.create({
        kind: 'photo',
        assetId,
        text: '课堂板书照片。原文：间隔重复，一天、三天、七天后自测复习。',
        origin: { device: 'phone' }
      }),
    image.id
  )
  await page.keyboard.press('ControlOrMeta+0')
  await page.getByRole('button', { name: '整理收件箱', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), text.id), { timeout: 180_000 })
    .toBe('suggested')
  const suggested = (await page.evaluate((id) => window.jiwei.inbox.get(id), text.id))!
  expect(suggested.suggestion?.action).toBe('append_note')
  expect(suggested.suggestion?.noteId).toBe(noteId)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.suggestion?.type ?? ''), photo.id), { timeout: 180_000 })
    .toMatch(/board|textbook_page/)
  await page.getByTestId(`inbox-${text.id}`).getByRole('button', { name: '接受建议' }).click()
  await expect.poll(() => markdown(noteId)).toContain('来自收件箱')
  expect(await markdown(noteId)).toMatch(/一天|三天|七天/)
})
