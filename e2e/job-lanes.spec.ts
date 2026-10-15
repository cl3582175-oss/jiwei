import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachmentModel } from './fixtures/attachment-model'

// eslint-disable-next-line no-empty-pattern -- Playwright 需要先写夹具参数才能拿到 testInfo
test('lane groups, bilingual waits and Digest now persist a real proposal through IPC', async ({}, testInfo) => {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-job-lanes-'))
  const model = await attachmentModel()
  model.setAnswer('# 受控总结\n\n已根据可用文字整理核心结论。')
  const app = await electron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_VOICE_MODELS_APPDATA: userData,
      JIWEI_TEST_NETWORK: '1',
      JIWEI_MEMORY_DELAY_MS: '3600000'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    expect(await app.evaluate(({ app }) => app.getPath('appData'))).toBe(process.env.JIWEI_TEST_MODEL_CACHE_ROOT)
    const { providerId, noteId } = await page.evaluate(async (baseUrl) => {
      const provider = await window.jiwei.providers.save({
        kind: 'openai',
        name: '分道受控服务',
        baseUrl,
        apiKey: 'controlled-test-key',
        models: ['controlled'],
        modelCaps: { controlled: { vision: true, tools: true, tier: 'strong' } }
      })
      const settings = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...settings.ai,
          chat: { providerId: provider.id, model: 'controlled' },
          effort: 'off',
          recognition: { mode: 'cloud', providerId: provider.id, model: 'controlled', auto: false, figures: false }
        },
        capture: { ...settings.capture, daily: false }
      })
      return { providerId: provider.id, noteId: (await window.jiwei.notes.create({ title: '任务分道定向验收' })).id }
    }, model.url)
    await app.evaluate(
      ({ app }, { providerId, noteId }) => {
        const req = process
          .getBuiltinModule('module')
          .createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
        try {
          const now = Date.now(),
            later = now + 3_600_000
          for (const id of ['lanes-source', 'lanes-parsing'])
            db.prepare("INSERT INTO sources(id,title,kind,accessed_at,created_at,updated_at) VALUES(?,?,'pdf',?,?,?)").run(
              id,
              id,
              now,
              now,
              now
            )
          db.prepare(
            'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
          ).run('lanes-segment-1', 'lanes-source', 0, 'text', '{"value":"page=1"}', '这份资料已有的文字部分。', 'controlled', now, now)
          for (const page of [3, 17, 20])
            db.prepare("INSERT INTO source_pages(source_id,page,need,status,updated_at) VALUES(? ,?,'scan','pending',?)").run(
              'lanes-source',
              page,
              now
            )
          const insert = db.prepare(
            "INSERT INTO jobs(id,kind,payload,status,dedupe_key,run_after,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?,?)"
          )
          const digest = (sourceId: string) => JSON.stringify({ sourceId, noteId, providerId, model: 'controlled', task: 'summary' })
          insert.run('lanes-digest', 'source.digest', digest('lanes-source'), null, later, now, now)
          insert.run('lanes-parsing-digest', 'source.digest', digest('lanes-parsing'), null, later, now, now)
          insert.run('lanes-parser', 'source.segment', '{"sourceId":"lanes-parsing"}', 'segment:lanes-parsing', later, now, now)
          insert.run('lanes-recognition', 'source.recognize', '{"sourceId":"lanes-source"}', 'recognize:lanes-source', later, now, now)
          insert.run('lanes-index', 'index.sync', '{}', 'index.sync', later, now, now)
        } finally {
          db.close()
        }
      },
      { providerId, noteId }
    )
    await page.reload()
    await page.waitForSelector('nav')
    await page.getByRole('button', { name: '后台任务', exact: true }).click()
    const user = page.getByTestId('jobs-lane-user'),
      background = page.getByTestId('jobs-lane-background')
    await expect(user).toContainText('你发起的')
    await expect(background).toContainText('后台整理资料')
    expect((await user.boundingBox())!.y).toBeLessThan((await background.boundingBox())!.y)
    await expect(page.getByTestId('job-lanes-digest')).toContainText('等待识别完成 · 0/3 页')
    await expect(page.getByTestId('job-lanes-parsing-digest')).toContainText('等待资料解析完成')
    await expect(page.getByTestId('job-lanes-digest').getByRole('button', { name: '现在就整理' })).toBeVisible()
    await expect(user).toBeVisible()
    await user.locator('..').screenshot({ path: testInfo.outputPath('job-lanes-zh.png'), animations: 'disabled' })

    await page.evaluate(() => window.jiwei.settings.set({ language: 'en' }))
    await page.reload()
    await page.waitForSelector('nav')
    await page.getByRole('button', { name: 'Background tasks', exact: true }).click()
    await expect(page.getByTestId('jobs-lane-user')).toContainText('Started by you')
    await expect(page.getByTestId('jobs-lane-background')).toContainText('Background source work')
    await expect(page.getByTestId('job-lanes-digest')).toContainText('Waiting for recognition · 0/3 pages')
    await expect(page.getByTestId('job-lanes-parsing-digest')).toContainText('Waiting for the source to finish parsing')
    await page
      .getByTestId('jobs-lane-user')
      .locator('..')
      .screenshot({ path: testInfo.outputPath('job-lanes-en.png'), animations: 'disabled' })
    await page.getByTestId('job-lanes-digest').getByRole('button', { name: 'Digest now', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === 'lanes-digest')?.status)
      .toBe('done')
    const proposals = await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)
    expect(proposals).toHaveLength(1)
    expect(JSON.stringify(proposals[0].ops)).toContain('Pages 3, 17, 20 could not be recognized')
    expect((await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === 'lanes-recognition')?.status).toBe('queued')
    const payload = await app.evaluate(({ app }) => {
      const req = process.getBuiltinModule('module').createRequire(process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
      try {
        return (db.prepare('SELECT payload FROM jobs WHERE id=?').get('lanes-digest') as { payload: string }).payload
      } finally {
        db.close()
      }
    })
    expect(JSON.parse(payload).noWait).toBe(true)
    expect(model.requests.length).toBeGreaterThanOrEqual(2)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})
