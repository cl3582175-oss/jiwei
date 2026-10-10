import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { startSafetyApp, pickSave, pickOpen, injectRecording, settingsData, type SafetyApp } from './fixtures/safetyApp'
import { readTar, writeTar, readTarBytes } from '../src/main/lib/tar'

let env: SafetyApp
const root = mkdtempSync(join(tmpdir(), 'jiwei-backup-e2e-'))
test.beforeAll(async () => {
  env = await startSafetyApp()
})
test.afterAll(async () => {
  await env?.close()
})

test('完整备份不包含翻译缓存，当前库缓存仍可继续使用', async () => {
  const marker = 'BACKUP_TRANSLATION_CACHE_PRIVATE_20261010'
  await env.app.evaluate(
    ({ app }, { path, marker }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const Database = load('better-sqlite3')
      const db = new Database(path)
      try {
        db.prepare(
          `INSERT INTO translation_cache (id,text_hash,target_language,style_version,translation,model,created_at,used_at,bytes)
        VALUES ('backup-cache','backup-cache','zh','test',?,'fixture',1,1,100)`
        ).run(marker)
      } finally {
        db.close()
      }
    },
    { path: join(env.userData, 'data/jiwei.db'), marker }
  )
  const snapshot = await env.page.evaluate(() => window.jiwei.backups.create())
  const bytes = readFileSync(join(env.userData, 'data/backups', snapshot.name, 'jiwei.db'))
  expect(bytes.includes(Buffer.from(marker)), '归档中的数据库不得保留被清除的缓存文本').toBe(false)
  const counts = await env.app.evaluate(
    ({ app }, paths) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const Database = load('better-sqlite3')
      return paths.map((path) => {
        const db = new Database(path, { readonly: true })
        try {
          return db.prepare('SELECT COUNT(*) AS n FROM translation_cache').get().n
        } finally {
          db.close()
        }
      })
    },
    [join(env.userData, 'data/jiwei.db'), join(env.userData, 'data/backups', snapshot.name, 'jiwei.db')]
  )
  expect(counts).toEqual([1, 0])
})

test('完整快照、归档、新知识库恢复：笔记、资料、录音、个人记忆持久化一致', async () => {
  test.setTimeout(90000)
  await env.page.keyboard.press('ControlOrMeta+n')
  await env.page.getByPlaceholder('笔记标题').fill('备份原始笔记')
  await env.page.keyboard.press('Enter')
  await env.page.locator('.cornell-body p').first().fill('完整备份必须保留康奈尔正文、资料、录音和个人记忆。')
  const image = join(root, 'image.svg')
  writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>')
  const source = await env.page.evaluate((path) => window.jiwei.sources.importPaths([path]), image)
  const recording = await injectRecording(env)
  const memory = await env.page.evaluate(() =>
    window.jiwei.memory.save({ kind: 'fact', key: 'backup-test', content: '恢复后的个人记忆', sensitive: false, pinned: true })
  )
  await settingsData(env)
  await env.page.getByRole('button', { name: '立即备份', exact: true }).click()
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.backups.status().then((s) => s.progress.state)), { timeout: 30000 })
    .toBe('done')
  const snapshot = (await env.page.evaluate(() => window.jiwei.backups.list())).find((b) => b.kind === 'manual')!
  expect(snapshot.format).toBe('snapshot')
  const file = join(root, 'backup.jiwei')
  await pickSave(env, file)
  await env.page.getByRole('button', { name: '导出备份文件…', exact: true }).click()
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.backups.status().then((s) => s.progress.state)), { timeout: 30000 })
    .toBe('done')
  expect((await readTar(file))[0].path).toBe('manifest.json')
  const notes = await env.page.evaluate(() => window.jiwei.notes.list({}))
  await env.page.evaluate((id) => window.jiwei.notes.update(id, { title: '备份后修改' }), notes[0].id)
  await env.page.evaluate(
    (id) =>
      window.jiwei.memory.save({ id, kind: 'fact', key: 'backup-test', content: '备份后修改个人记忆', sensitive: false, pinned: true }),
    memory.id
  )
  await pickOpen(env, file)
  const preview = await env.page.evaluate(() => window.jiwei.backups.preview())
  expect(preview?.manifest.recordings).toBe(1)
  expect(preview?.manifest.includeProfile).toBe(true)
  const destination = join(root, 'restored')
  await pickSave(env, destination)
  const restored = await env.page.evaluate(
    (token) => window.jiwei.backups.restore({ token, mode: 'new', includeProfile: true, confirmed: false }),
    preview!.token
  )
  expect(restored?.path).toBe(destination)
  expect((await env.page.evaluate(() => window.jiwei.memory.list({ search: '恢复后的个人记忆' }))).some((m) => m.id === memory.id)).toBe(
    true
  )
  expect(await env.page.evaluate(() => window.jiwei.memory.list({ search: '备份后修改个人记忆' }))).toHaveLength(0)
  await expect.poll(() => env.page.evaluate(() => window.jiwei.notes.list({}).then((n) => n[0].title))).toBe('备份后修改')
  const fresh = await startSafetyApp({ vault: destination })
  try {
    expect((await fresh.page.evaluate(() => window.jiwei.notes.list({})))[0].title).toBe('备份原始笔记')
    await fresh.page.getByText('备份原始笔记', { exact: true }).first().click()
    await expect(fresh.page.locator('.cornell-body').first()).toContainText('完整备份必须保留康奈尔正文、资料、录音和个人记忆。')
    expect(await fresh.page.evaluate((id) => window.jiwei.sources.get(id), source.imported[0].id)).toBeTruthy()
    const bytes = await fresh.page.evaluate(
      async (id) => (await (await fetch(`jiwei://recording/${id}`)).arrayBuffer()).byteLength,
      recording.sourceId!
    )
    expect(bytes).toBeGreaterThan(100)
  } finally {
    await fresh.close()
  }
  const status = await env.page.evaluate(() => window.jiwei.backups.status())
  expect(status.restoredVault?.path).toBe(destination)
  if (process.env.SHOTS_DIR) {
    mkdirSync(process.env.SHOTS_DIR, { recursive: true })
    await env.page.screenshot({ path: join(process.env.SHOTS_DIR, 'backup-restored.png') })
  }
})
test('损坏归档和更新迁移版本被拒，旧知识库不变', async () => {
  const original = join(root, 'backup.jiwei'),
    damaged = join(root, 'damaged.jiwei'),
    bytes = Buffer.from(readFileSync(original)),
    entries = await readTar(original),
    audio = entries.find((e) => e.path.includes('mix.webm'))!
  bytes[audio.offset + 8] ^= 1
  writeFileSync(damaged, bytes)
  await pickOpen(env, damaged)
  const preview = await env.page.evaluate(() => window.jiwei.backups.preview())
  const destination = join(root, 'bad-restored')
  await pickSave(env, destination)
  await expect(
    env.page.evaluate(
      (token) => window.jiwei.backups.restore({ token, mode: 'new', includeProfile: false, confirmed: false }),
      preview!.token
    )
  ).rejects.toThrow(/录音.*损坏/)
  const manifest = JSON.parse((await readTarBytes(original, entries[0], 1000000)).toString())
  manifest.knowledgeVersion += 1
  const newer = join(root, 'newer.jiwei')
  await writeTar(
    newer,
    await Promise.all(
      entries.map(async (e) => ({
        path: e.path,
        bytes: e.path === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : await readTarBytes(original, e, 10000000)
      }))
    )
  )
  await pickOpen(env, newer)
  await expect(env.page.evaluate(() => window.jiwei.backups.preview())).rejects.toThrow(/先升级/)
  expect((await env.page.evaluate(() => window.jiwei.notes.list({})))[0].title).toBe('备份后修改')
})
test('取消导出清理 partial，外部位置不可用时显示状态', async () => {
  const file = join(root, 'cancel.jiwei')
  await pickSave(env, file)
  const result = await env.page.evaluate(async () => {
    const pending = window.jiwei.backups.export().then(
      () => 'done',
      () => 'canceled'
    )
    await window.jiwei.backups.cancel()
    return pending
  })
  expect(result).toBe('canceled')
  expect(readdirSync(root)).not.toContain('cancel.jiwei.partial')
  await env.page.evaluate(
    (path) => window.jiwei.settings.set({ backup: { external: { path, frequency: 'daily', keep: 4 } } }),
    join(root, 'disconnected')
  )
  await expect.poll(() => env.page.evaluate(() => window.jiwei.backups.status().then((s) => s.externalUnavailable))).toBe(true)
  await expect(env.page.getByTestId('backup-settings')).toContainText('位置不可用')
})

test('替换当前知识库前完整备份，重启后恢复成功并可回退', async () => {
  test.setTimeout(90000)
  const userData = env.userData
  const replace = async (token: string): Promise<void> => {
    // 保留实际退出与重启落盘行为，由测试接管 relaunch 避免遗留无人管理的应用。
    await env.app.evaluate(({ app }) => {
      app.relaunch = () => {}
    })
    const closed = new Promise<void>((resolve) => env.app.process().once('exit', () => resolve()))
    const operation = env.page
      .evaluate((token) => window.jiwei.backups.restore({ token, mode: 'replace', includeProfile: false, confirmed: true }), token)
      .catch((error) => {
        if (!/closed|destroyed/i.test(String(error))) throw error
      })
    await Promise.all([closed, operation])
    env = await startSafetyApp({ userData })
  }
  await pickOpen(env, join(root, 'backup.jiwei'))
  const preview = await env.page.evaluate(() => window.jiwei.backups.preview())
  await expect(
    env.page.evaluate(
      (token) => window.jiwei.backups.restore({ token, mode: 'replace', includeProfile: false, confirmed: false }),
      preview!.token
    )
  ).rejects.toThrow(/再次确认/)
  await replace(preview!.token)
  expect((await env.page.evaluate(() => window.jiwei.notes.list({})))[0].title).toBe('备份原始笔记')
  const before = (await env.page.evaluate(() => window.jiwei.backups.list())).find((b) => b.kind === 'pre-restore')
  expect(before?.format).toBe('snapshot')
  const rollback = await env.page.evaluate((name) => window.jiwei.backups.preview(name), before!.name)
  await replace(rollback!.token)
  expect((await env.page.evaluate(() => window.jiwei.notes.list({})))[0].title).toBe('备份后修改')
  expect(
    (await env.page.evaluate(() => window.jiwei.backups.list())).filter((b) => b.kind === 'pre-restore').length
  ).toBeGreaterThanOrEqual(2)
})
