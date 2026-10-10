import { test, expect } from '@playwright/test'
import { startLensApp, seedTranscript, openTranscript, runLens, lensShot, setLensTheme, type LensApp } from './fixtures/lensApp'

test.describe.configure({ mode: 'serial' })
let env: LensApp
test.beforeAll(async () => {
  env = await startLensApp()
})
test.afterAll(async () => env?.close())

test('证据定位、分段原声播放、宽屏并排与窄窗标签页', async () => {
  const { sourceId } = await seedTranscript(env, 'meeting', { audio: true })
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '预算流程例会')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(5)
  await panel.getByTestId('lens-evidence').first().click()
  await expect(env.page.locator('[data-evidence=true]')).toBeVisible()
  await expect
    .poll(() => env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => !m.paused && m.currentTime >= 0 && m.currentTime < 8))
    .toBe(true)
  await expect.poll(() => env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.paused), { timeout: 15000 }).toBe(true)
  await expect.poll(() => env.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.currentTime)).toBeLessThan(8.5)
  if (process.env.JIWEI_TEST_WINDOW) {
    await expect(env.page.getByTestId('lens-workspace')).toHaveAttribute('data-layout', 'tabs')
    await env.page.getByRole('tab', { name: '整理结果' }).click()
  } else {
    // 普通笔记本窗口：整理时资料栏自动放宽，左右两栏在 1440 宽内即可放下，不需要超出屏幕的窗口
    await env.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    expect(await env.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(env.page.getByTestId('lens-workspace')).toHaveAttribute('data-layout', 'columns')
  }
  for (const theme of ['light', 'dark'] as const) {
    await setLensTheme(env, theme)
    await panel.getByTestId('lens-item').first().scrollIntoViewIfNeeded()
    await lensShot(env, `lens-meeting-${theme}.png`)
    expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    const footer = panel.getByTestId('lens-footer')
    expect(await footer.evaluate((e) => e.getBoundingClientRect().bottom <= window.innerHeight && e.scrollWidth <= e.clientWidth)).toBe(
      true
    )
  }
  expect((await env.page.evaluate((id) => window.jiwei.lenses.history(id), sourceId))[0].result?.sentences[0].segmentId).toBe(
    `${sourceId}-0`
  )
})

test('自定义指令运行、保存、设置编辑与删除；普通技能隔离', async () => {
  await seedTranscript(env, 'thought')
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '散步时的学习随想')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '自定义指令', exact: true }).click()
  await panel.getByRole('textbox', { name: '输入一句整理指令' }).fill('保留我提出的问题，逐条给原话证据。')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(1)
  await panel.getByRole('button', { name: '保存为视角' }).click()
  await env.page.getByRole('textbox', { name: '视角名称' }).fill('../思考视角')
  await env.page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.lenses.list().then((ls) => ls.find((l) => l.title === '../思考视角')?.id)))
    .toMatch(/^lens-[a-f0-9]{8}$/)
  await env.page.getByRole('button', { name: /^设置/ }).click()
  await env.page.getByRole('dialog').getByRole('button', { name: '视角', exact: true }).click()
  const settings = env.page.getByTestId('lens-settings'),
    row = settings.locator('article').filter({ hasText: '../思考视角' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '修改视角' }).click()
  await env.page.getByRole('textbox', { name: '视角名称' }).fill('思考视角改名')
  await env.page.getByRole('textbox', { name: '输入一句整理指令' }).fill('只保留原话。')
  await env.page.getByRole('dialog').last().getByRole('button', { name: '保存', exact: true }).click()
  await expect(settings.getByText('思考视角改名', { exact: true })).toBeVisible()
  const ids = await env.page.evaluate(() => window.jiwei.skills.list().then((s) => s.map((s) => s.name)))
  expect(ids.some((id) => id.startsWith('lens-'))).toBe(false)
  await settings.locator('article').filter({ hasText: '思考视角改名' }).getByRole('button', { name: '删除视角' }).click()
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.lenses.list().then((ls) => ls.some((l) => l.title === '思考视角改名'))))
    .toBe(false)
  await env.page.keyboard.press('Escape')
})

test('历史保留、版本切换、转写纠错后 stale，失败不覆盖旧结果', async () => {
  const { sourceId } = await seedTranscript(env, 'meeting', { title: '历史会议' })
  const first = await runLens(env, sourceId, 'lens-meeting'),
    second = await runLens(env, sourceId, 'lens-brief')
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '历史会议')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByLabel('历史版本').selectOption(first.id)
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(5)
  await panel.getByLabel('历史版本').selectOption(second.id)
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(3)
  env.state.fail = true
  const failed = await env.page.evaluate((sourceId) => window.jiwei.lenses.run({ sourceId, lens: 'lens-meeting' }), sourceId)
  await expect
    .poll(
      () =>
        env.page.evaluate(({ sourceId, id }) => window.jiwei.lenses.history(sourceId).then((d) => d.find((d) => d.id === id)?.status), {
          sourceId,
          id: failed.id
        }),
      { timeout: 30000 }
    )
    .toBe('failed')
  env.state.fail = false
  expect((await env.page.evaluate((id) => window.jiwei.lenses.history(id), sourceId)).find((d) => d.id === first.id)?.status).toBe('ready')
  await env.page.evaluate((id) => window.jiwei.segments.update(`${id}-0`, '现在讨论预算审批和培训范围。'), sourceId)
  await expect
    .poll(() =>
      env.page.evaluate((id) => window.jiwei.lenses.history(id).then((d) => d.filter((d) => d.status === 'stale').length), sourceId)
    )
    .toBe(2)
  await expect(panel.getByText('转写稿已修改，可重新整理。')).toBeVisible()
  await expect(panel.getByRole('button', { name: '落地', exact: true })).toBeDisabled()
})

test('系列创建、第二次开始面板待办、系列页与人物页及备注', async () => {
  await env.page.getByRole('button', { name: /录音 ⌘7/ }).click()
  const start = env.page.getByTestId('recording-start')
  await start.getByRole('button', { name: '新建系列' }).click()
  await env.page.getByRole('textbox', { name: '系列名称' }).fill('每周预算例会')
  await env.page.getByRole('dialog').getByRole('button', { name: '新建', exact: true }).click()
  const seriesId = await env.page.evaluate(() => window.jiwei.series.list().then((s) => s.find((s) => s.name === '每周预算例会')!.id))
  const { sourceId, personIds } = await seedTranscript(env, 'meeting', { seriesId, title: '系列第一次会议' })
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '系列第一次会议')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(5)
  await panel.getByRole('button', { name: '落地', exact: true }).click()
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.series.openActions(id).then((a) => a.length), seriesId)).toBe(1)
  for (const theme of ['light', 'dark'] as const) {
    await setLensTheme(env, theme)
    await panel.getByTestId('lens-receipt').scrollIntoViewIfNeeded()
    await lensShot(env, `lens-landed-${theme}.png`)
  }
  await env.page.getByRole('button', { name: /录音 ⌘7/ }).click()
  await env.page.getByTestId('recording-start').getByLabel('系列', { exact: true }).selectOption(seriesId)
  await expect(env.page.getByTestId('series-pending')).toContainText('准备预算表')
  for (const theme of ['light', 'dark'] as const) {
    await setLensTheme(env, theme)
    await lensShot(env, `lens-series-pending-${theme}.png`)
  }
  await env.page.getByTestId('recording-start').getByRole('button', { name: '查看系列' }).click()
  await expect(env.page.getByTestId('series-page')).toContainText('系列第一次会议')
  await expect(env.page.getByTestId('series-page')).toContainText('准备预算表')
  for (const theme of ['light', 'dark'] as const) {
    await env.page.keyboard.press('Escape')
    await setLensTheme(env, theme)
    await env.page.getByTestId('recording-start').getByRole('button', { name: '查看系列' }).click()
    await lensShot(env, `lens-series-${theme}.png`)
  }
  await env.page.keyboard.press('Escape')
  await openTranscript(env, '系列第一次会议')
  await env.page
    .getByRole('button', { name: /更改.*老李/ })
    .first()
    .click()
  await env.page.getByTestId('speaker-choices').getByRole('button', { name: '查看此人' }).click()
  const person = env.page.getByTestId('person-page')
  await expect(person).toContainText('准备预算表')
  await expect(person).toContainText('预算审批时间太长')
  await person.getByRole('textbox', { name: '备注', exact: true }).fill('预算流程负责人')
  await person.getByRole('button', { name: '保存备注' }).click()
  await expect
    .poll(() => env.page.evaluate((id) => window.jiwei.people.page(id).then((p) => p.person?.note), personIds[1]))
    .toBe('预算流程负责人')
  await lensShot(env, 'lens-person-dark.png')
  await person.getByRole('checkbox').first().click()
  await expect.poll(() => person.getByRole('checkbox').first().isChecked()).toBe(true)
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.series.openActions(id).then((a) => a.length), seriesId)).toBe(0)
  await env.page.keyboard.press('Escape')
  await setLensTheme(env, 'light')
  await env.page
    .getByRole('button', { name: /更改.*老李/ })
    .first()
    .click()
  await env.page.getByTestId('speaker-choices').getByRole('button', { name: '查看此人' }).click()
  await lensShot(env, 'lens-person-light.png')
  await env.page.keyboard.press('Escape')
  const second = await seedTranscript(env, 'meeting', { seriesId, title: '系列第二次会议' })
  await runLens(env, second.sourceId, 'lens-meeting')
  const request = env.requests.filter((r) => r.kind === 'meeting').at(-1)!
  expect(request.prompt).toContain(sourceId)
  expect(request.prompt).toContain('预算流程和下周试用安排')
})

test('低把握先选择；仅本地和无模型不调用服务商', async () => {
  env.state.confidence = 0.6
  const low = await seedTranscript(env, 'meeting', { scene: 'unspecified', title: '未指定场景' })
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '未指定场景')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await expect(panel.getByText(/把握 60%/)).toBeVisible()
  await expect(panel.getByRole('button', { name: '开始整理', exact: true })).toBeDisabled()
  await expect(env.page.evaluate((id) => window.jiwei.lenses.run({ sourceId: id, lens: 'lens-meeting' }), low.sourceId)).rejects.toThrow(
    /选择场景/
  )
  await panel.getByRole('button', { name: '会议纪要' }).click()
  await expect(panel.getByRole('button', { name: '开始整理', exact: true })).toBeEnabled()
  env.state.confidence = 0.9
  const local = await seedTranscript(env, 'thought', { local: true, scene: 'unspecified', title: '本地随想' }),
    before = env.requests.length
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '本地随想')
  await expect(env.page.getByRole('button', { name: '整理', exact: true })).toBeDisabled()
  expect(await env.page.evaluate((id) => window.jiwei.lenses.guess(id), local.sourceId)).toBeNull()
  await expect(env.page.evaluate((id) => window.jiwei.lenses.run({ sourceId: id, lens: 'lens-thought' }), local.sourceId)).rejects.toThrow(
    /仅本地/
  )
  expect(env.requests.length).toBe(before)
  const isolated = await startLensApp({ provider: false })
  try {
    await seedTranscript(isolated, 'meeting')
    await isolated.page.reload()
    await isolated.page.waitForSelector('nav')
    await openTranscript(isolated, '预算流程例会')
    await isolated.page.getByRole('button', { name: '整理', exact: true }).click()
    await expect(isolated.page.getByTestId('lens-unavailable')).toContainText('配置对话模型')
    await expect(isolated.page.getByRole('button', { name: '开始整理', exact: true })).toBeDisabled()
    expect(isolated.requests).toHaveLength(0)
  } finally {
    await isolated.close()
  }
})

test('运行中的隐私切换、取消、改稿：迟到回复不能发布', async () => {
  for (const mode of ['privacy', 'cancel', 'edit'] as const) {
    const { sourceId } = await seedTranscript(env, 'meeting', { title: `运行保护-${mode}` }),
      before = env.requests.length
    env.state.blocked = true
    const d = await env.page.evaluate((sourceId) => window.jiwei.lenses.run({ sourceId, lens: 'lens-meeting' }), sourceId)
    await expect.poll(() => env.requests.length).toBe(before + 1)
    if (mode === 'privacy') await env.page.evaluate((id) => window.jiwei.sources.update(id, { aiExcluded: true }), sourceId)
    if (mode === 'cancel') await env.page.evaluate((id) => window.jiwei.jobs.cancel(id), d.jobId!)
    if (mode === 'edit') await env.page.evaluate((id) => window.jiwei.segments.update(`${id}-0`, '人工改稿，保留修改。'), sourceId)
    env.state.blocked = false
    env.state.release?.()
    await expect
      .poll(() =>
        env.page.evaluate(({ sourceId, id }) => window.jiwei.lenses.history(sourceId).then((ds) => ds.find((d) => d.id === id)?.status), {
          sourceId,
          id: d.id
        })
      )
      .toBe(mode === 'cancel' ? 'canceled' : mode === 'edit' ? 'stale' : 'failed')
    const after = await env.page.evaluate(
      ({ sourceId, id }) => window.jiwei.lenses.history(sourceId).then((ds) => ds.find((d) => d.id === id)!),
      { sourceId, id: d.id }
    )
    expect(after.result).toBeNull()
    expect(env.requests.length).toBe(before + 1)
    if (mode !== 'cancel') await env.page.evaluate((id) => window.jiwei.jobs.cancel(id), d.jobId!)
  }
})

test('候选身份与发言归属限制；未经 renderer 应用的提案不能确认', async () => {
  const { sourceId } = await seedTranscript(env, 'thought', { title: '候选保护' })
  env.state.respond = (kind) =>
    kind === 'thought'
      ? {
          paragraphs: [{ title: '原话', body: '我想把学习笔记变成能继续思考的地方。', evidence: ['u1'], speaker: 'S99' }],
          ideas: [],
          questions: [],
          plans: [],
          links: [
            {
              title: '伪造笔记',
              body: '我想把学习笔记变成能继续思考的地方。',
              evidence: ['u1'],
              noteId: '../../private',
              relation: 'similar'
            }
          ]
        }
      : undefined
  try {
    const d = await runLens(env, sourceId, 'lens-thought')
    expect(d.result?.items).toHaveLength(1)
    expect(d.result?.items[0].speaker).toBeUndefined()
    expect(d.stats?.dropped.map((x) => x.field)).toEqual(['speaker', 'noteId'])
    const landing = await env.page.evaluate(
      (d) => window.jiwei.lenses.prepare({ derivationId: d.id, items: d.result!.items, noteId: null }),
      d
    )
    await expect(
      env.page.evaluate(
        async (landing) => window.jiwei.lenses.complete(landing.id, await window.jiwei.notes.loadDoc(landing.noteId!)),
        landing
      )
    ).rejects.toThrow(/提案尚未正确应用/)
    expect(await env.page.evaluate((id) => window.jiwei.lenses.landings(id).then((ls) => ls[0].status), d.id)).toBe('pending')
    await expect(
      env.page.evaluate(
        (d) =>
          window.jiwei.lenses.prepare({
            derivationId: d.id,
            items: d.result!.items.map((i) => ({ ...i, body: '用户已修改这次审阅的正文' })),
            noteId: null
          }),
        d
      )
    ).rejects.toThrow(/待确认.*恢复/)
    const destination = await env.page.evaluate(() => window.jiwei.notes.create({ title: '恢复时新选择的目标' }).then((n) => n.id))
    await expect(
      env.page.evaluate(
        ({ d, destination }) => window.jiwei.lenses.prepare({ derivationId: d.id, items: d.result!.items, noteId: destination }),
        { d, destination }
      )
    ).rejects.toThrow(/待确认.*恢复/)
    await env.page.reload()
    await env.page.waitForSelector('nav')
    await openTranscript(env, '候选保护')
    await env.page.getByRole('button', { name: '整理', exact: true }).click()
    const review = env.page.getByTestId('lens-panel')
    await review.getByLabel('正文', { exact: true }).fill('用户当前编辑的审阅正文')
    await review.getByRole('button', { name: '落地', exact: true }).click()
    await expect(review.getByRole('alert')).toContainText('请恢复待确认审阅')
    await review.getByRole('button', { name: '恢复待确认审阅', exact: true }).click()
    await expect(review.getByLabel('正文', { exact: true })).toHaveValue(d.result!.items[0].body)
    await review.getByRole('button', { name: '落地', exact: true }).click()
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.lenses.landings(id).then((ls) => ls[0].status), d.id)).toBe('applied')
    expect(await env.page.evaluate((id) => window.jiwei.lenses.landings(id).then((ls) => ls.length), d.id)).toBe(1)
  } finally {
    env.state.respond = null
  }
})

test('逐句纠正后同一标签按证据归属人物，落地显示已确认姓名', async () => {
  const { sourceId, personIds } = await seedTranscript(env, 'meeting', { title: '逐句人物归属' })
  await env.page.evaluate(
    async ({ sourceId, personIds }) => {
      const segs = await window.jiwei.segments.list(sourceId)
      await window.jiwei.recording.confirm({ sourceId, label: 'S01', segmentId: segs[6].id, personId: personIds[2] })
    },
    { sourceId, personIds }
  )
  env.state.respond = (kind) =>
    kind === 'meeting'
      ? {
          topic: { title: '预算', body: '决定下周试用新的预算流程，只在研发组试用一周。', evidence: ['u7'] },
          agendas: [{ title: '观点', body: '决定下周试用新的预算流程，只在研发组试用一周。', evidence: ['u7'], speaker: 'S01' }],
          decisions: [],
          questions: [],
          risks: [],
          progress: [],
          actions: [{ title: '试用', body: '决定下周试用新的预算流程，只在研发组试用一周。', evidence: ['u7'], owner: 'S01' }]
        }
      : undefined
  try {
    const d = await runLens(env, sourceId, 'lens-meeting')
    const agenda = d.result!.items.find((i) => i.category === 'agenda')!,
      action = d.result!.items.find((i) => i.category === 'action')!
    expect(agenda.speakerPersonId).toBe(personIds[2])
    expect(agenda.speaker).toBe('小王')
    expect(action.ownerPersonId).toBe(personIds[2])
    const person = await env.page.evaluate((id) => window.jiwei.people.page(id), personIds[2])
    expect(person.viewpoints.some((v) => v.derivationId === d.id)).toBe(true)
    await env.page.evaluate(
      async ({ sourceId, personId }) => {
        const segs = await window.jiwei.segments.list(sourceId)
        await window.jiwei.recording.confirm({ sourceId, label: 'S01', segmentId: segs[6].id, personId })
      },
      { sourceId, personId: personIds[1] }
    )
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.people.page(id).then((p) => p.viewpoints), personIds[2])).toEqual([])
    const fresh = await runLens(env, sourceId, 'lens-meeting'),
      latest = await runLens(env, sourceId, 'lens-meeting')
    const viewpoints = await env.page.evaluate((id) => window.jiwei.people.page(id).then((p) => p.viewpoints), personIds[1])
    expect(viewpoints.some((v) => v.derivationId === fresh.id)).toBe(false)
    expect(viewpoints.some((v) => v.derivationId === latest.id)).toBe(true)
  } finally {
    env.state.respond = null
  }
})

test('整理提案拒绝通用决议，恢复仍可由整理面板确认', async () => {
  const { sourceId } = await seedTranscript(env, 'thought', { title: '专属整理提案' })
  const d = await runLens(env, sourceId, 'lens-thought')
  const landing = await env.page.evaluate(
    (d) => window.jiwei.lenses.prepare({ derivationId: d.id, items: d.result!.items, noteId: null }),
    d
  )
  for (const decision of ['accepted', 'rejected'] as const) {
    await expect(
      env.page.evaluate(({ id, decision }) => window.jiwei.proposals.resolve(id, 0, decision), { id: landing.proposalId!, decision })
    ).rejects.toThrow(/整理面板/)
  }
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '专属整理提案')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '恢复待确认审阅', exact: true }).click()
  await panel.getByRole('button', { name: '落地', exact: true }).click()
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.lenses.landings(id).then((l) => l[0].status), d.id)).toBe('applied')
})

test('人物观点排除纠错后过期稿，重复整理只显示最新版本', async () => {
  const { sourceId, personIds } = await seedTranscript(env, 'meeting')
  const first = await runLens(env, sourceId, 'lens-meeting')
  expect(
    (await env.page.evaluate((id) => window.jiwei.people.page(id), personIds[1])).viewpoints.some((v) => v.derivationId === first.id)
  ).toBe(true)
  await env.page.evaluate(async (sourceId) => {
    const s = (await window.jiwei.segments.list(sourceId))[3]
    await window.jiwei.segments.update(s.id, s.text + ' 这是已纠正的观点。')
  }, sourceId)
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.people.page(id).then((p) => p.viewpoints), personIds[1])).toEqual([])
  const second = await runLens(env, sourceId, 'lens-meeting'),
    third = await runLens(env, sourceId, 'lens-meeting')
  const current = (await env.page.evaluate((id) => window.jiwei.people.page(id), personIds[1])).viewpoints
  expect(current.some((v) => v.derivationId === second.id)).toBe(false)
  expect(current.some((v) => v.derivationId === third.id)).toBe(true)
})

test('进展默认保留未完成；显式完成同一待办一次，撤销恢复原状态', async () => {
  const seriesId = await env.page.evaluate(() => window.jiwei.series.save({ name: '进展确认系列', scene: 'meeting' }).then((s) => s.id))
  const first = await seedTranscript(env, 'meeting', { seriesId })
  env.state.respond = (kind) =>
    kind === 'items'
      ? {
          items: [{ title: '预算表', body: '老李明天准备预算表，把三个必填字段写清楚。', evidence: ['u11'], category: 'action' }]
        }
      : undefined
  try {
    const todo = await runLens(env, first.sourceId, 'lens-todos')
    await env.page.evaluate(async (d) => {
      const p = await window.jiwei.lenses.prepare({ derivationId: d.id, items: d.result!.items, noteId: null })
      await window.jiwei.lenses.complete(p.id, new Uint8Array(0))
    }, todo)
    const actionId = await env.page.evaluate((id) => window.jiwei.series.openActions(id).then((a) => a[0].id), seriesId)
    const second = await seedTranscript(env, 'meeting', { seriesId, title: '进展审阅' })
    env.state.respond = (kind) =>
      kind === 'meeting'
        ? {
            topic: { title: '预算', body: '预算流程和下周试用安排', evidence: ['u1'] },
            agendas: [],
            decisions: [],
            actions: [],
            questions: [],
            risks: [],
            progress: [
              { title: '仍未准备好', body: '老李还没有准备预算表，明天继续准备。', evidence: ['u11'], actionId },
              { title: '字段进展', body: '预算表准备仍需把三个必填字段写清楚。', evidence: ['u11'], actionId }
            ]
          }
        : undefined
    const d = await runLens(env, second.sourceId, 'lens-meeting')
    await env.page.reload()
    await env.page.waitForSelector('nav')
    await openTranscript(env, '进展审阅')
    await env.page.getByRole('button', { name: '整理', exact: true }).click()
    const panel = env.page.getByTestId('lens-panel')
    await panel.getByRole('button', { name: '落地', exact: true }).click()
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.lenses.landings(id).then((l) => l[0]?.status), d.id)).toBe('applied')
    await expect
      .poll(() => env.page.evaluate((id) => window.jiwei.series.openActions(id).then((a) => a.map((a) => a.id)), seriesId))
      .toEqual([actionId])
    await panel.getByRole('button', { name: '撤销本次落地' }).click()
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.lenses.landings(id).then((l) => l[0]?.status), d.id)).toBe('undone')
    for (const checkbox of await panel.getByRole('checkbox', { name: '接受条目', exact: true }).all()) await checkbox.check()
    await expect.poll(() => panel.getByRole('checkbox', { name: '确认上次待办已完成', exact: true }).count()).toBe(2)
    for (const checkbox of await panel.getByRole('checkbox', { name: '确认上次待办已完成', exact: true }).all()) await checkbox.check()
    await panel.getByRole('button', { name: '落地', exact: true }).click()
    await expect.poll(() => env.page.evaluate((id) => window.jiwei.series.openActions(id).then((a) => a.length), seriesId)).toBe(0)
    const completed = await env.page.evaluate(
      (id) => window.jiwei.lenses.landings(id).then((l) => l.find((l) => l.status === 'applied')!),
      d.id
    )
    expect(completed.objects.filter((o) => o.kind === 'progress')).toHaveLength(1)
    await panel.getByRole('button', { name: '撤销本次落地' }).click()
    await expect
      .poll(() => env.page.evaluate((id) => window.jiwei.series.openActions(id).then((a) => a.map((a) => a.id)), seriesId))
      .toEqual([actionId])
  } finally {
    env.state.respond = null
  }
})

test('跨版本疑似重复默认不勾选，修改已落地行动项后禁止撤销', async () => {
  const { sourceId } = await seedTranscript(env, 'meeting', { title: '重复与撤销保护' })
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '重复与撤销保护')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(5)
  await panel.getByRole('button', { name: '落地', exact: true }).click()
  await expect
    .poll(() =>
      env.page.evaluate(
        (id) => window.jiwei.lenses.history(id).then(async (ds) => (await window.jiwei.lenses.landings(ds[0].id))[0]?.status),
        sourceId
      )
    )
    .toBe('applied')
  const first = await env.page.evaluate(
    (id) => window.jiwei.lenses.history(id).then(async (ds) => (await window.jiwei.lenses.landings(ds[0].id))[0]),
    sourceId
  )
  await env.page.evaluate(async (landing) => {
    const action = landing.objects.find((o) => o.kind === 'action')!
    await window.jiwei.actions.update(action.id, { title: '用户修改后的行动项' })
  }, first)
  await expect(env.page.evaluate((id) => window.jiwei.lenses.undo(id), first.id)).rejects.toThrow(/对象已被修改/)
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.lenses.history(id).then((ds) => ds.length), sourceId)).toBe(2)
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(5)
  await expect
    .poll(() =>
      panel
        .getByTestId('lens-item')
        .getByRole('checkbox', { name: '接受条目' })
        .evaluateAll((inputs) => inputs.filter((i) => (i as HTMLInputElement).checked).length)
    )
    .toBe(0)
  await expect(panel.getByRole('button', { name: '落地', exact: true })).toBeDisabled()
})

test('实际知识检索组合过滤，资料筛选按人场景系列，私有稿件排除', async () => {
  const s = await env.page.evaluate(() => window.jiwei.series.save({ name: '检索例会', scene: 'meeting', categoryId: null })),
    good = await seedTranscript(env, 'meeting', { title: '检索会议', seriesId: s.id }),
    privateSource = await seedTranscript(env, 'meeting', { local: true, title: '私有会议', seriesId: s.id })
  for (const id of [good.sourceId, privateSource.sourceId])
    await env.page.evaluate((id) => window.jiwei.segments.update(`${id}-3`, '老李讨论预算审批的优化。'), id)
  const filters = { personId: good.personIds[1], scene: 'meeting' as const, seriesId: s.id, from: '2026-10-10', to: '2026-10-10' }
  const hits = await env.page.evaluate((filters) => window.jiwei.knowledge.search('预算审批', { type: 'all' }, 10, filters), filters)
  expect(hits.length).toBeGreaterThan(0)
  expect(hits.every((h) => h.parentId === good.sourceId)).toBe(true)
  expect(
    await env.page.evaluate(
      (filters) => window.jiwei.knowledge.search('预算审批', { type: 'all' }, 10, { ...filters, scene: 'lecture' }),
      filters
    )
  ).toEqual([])
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await env.page.getByRole('button', { name: /资料库/ }).click()
  await env.page.getByLabel('场景', { exact: true }).selectOption('meeting')
  await env.page.getByLabel('全部系列', { exact: true }).selectOption(s.id)
  await expect(env.page.getByText('检索会议', { exact: true })).toBeVisible()
  await env.page.getByRole('button', { name: /录音 ⌘7/ }).click()
  await env.page.getByLabel('所有人', { exact: true }).selectOption(good.personIds[1])
  await expect.poll(() => env.page.getByRole('button', { name: /会议 ·/ }).count()).toBe(1)
})

test('缺省和手改线索在审阅与真实派生卡片中保持一致', async () => {
  const { sourceId } = await seedTranscript(env, 'lecture', { title: '缺省线索审阅' })
  env.state.respond = (kind) =>
    kind === 'items'
      ? {
          items: [
            { title: '间隔重复', body: '把复习分散到不同时间，而不是一天全部重复。', evidence: ['u5'], category: 'quiz' },
            { title: '提取练习', body: '合上材料，主动尝试回忆学过的知识。', evidence: ['u9'], category: 'quiz' }
          ]
        }
      : null
  try {
    await env.page.reload()
    await env.page.waitForSelector('nav')
    await openTranscript(env, '缺省线索审阅')
    await env.page.getByRole('button', { name: '整理', exact: true }).click()
    const panel = env.page.getByTestId('lens-panel')
    await panel.getByLabel('更多视角').selectOption('lens-quiz')
    await panel.getByRole('button', { name: '开始整理', exact: true }).click()
    await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(2)
    const firstCue = panel.getByTestId('lens-item').filter({ hasText: '间隔重复' }).getByLabel('线索问题', { exact: true })
    const secondCue = panel.getByTestId('lens-item').filter({ hasText: '提取练习' }).getByLabel('线索问题', { exact: true })
    await expect(firstCue).toHaveValue('间隔重复？')
    await expect(secondCue).toHaveValue('提取练习？')
    await secondCue.fill('如何进行提取练习？')
    const reviewed = [await firstCue.inputValue(), await secondCue.inputValue()].sort()
    await panel.getByRole('button', { name: '落地', exact: true }).click()
    await expect
      .poll(() =>
        env.page.evaluate(
          (id) =>
            window.jiwei.lenses.history(id).then(async (versions) => {
              const landing = (await window.jiwei.lenses.landings(versions[0].id))[0]
              if (!landing?.noteId) return []
              const cards = await window.jiwei.review.forNote(landing.noteId)
              const content = await Promise.all(cards.map((card) => window.jiwei.review.get(card.id)))
              return content.map((card) => card?.question).sort()
            }),
          sourceId
        )
      )
      .toEqual(reviewed)
  } finally {
    env.state.respond = null
  }
})

test('长转写实际分段、证据并集与受限汇总；途中私有化不发下一段', async () => {
  const { sourceId, personIds } = await seedTranscript(env, 'meeting', { title: '长转写技术验证' })
  await env.app.evaluate(
    ({ app }, { sourceId, personId }) => {
      const path = process.getBuiltinModule('path'),
        req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json')),
        Database = req('better-sqlite3') as typeof import('better-sqlite3'),
        db = new Database(path.join(app.getPath('userData'), 'data/jiwei.db'))
      try {
        const insert = db.prepare(
          'INSERT INTO source_segments (id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        db.transaction(() => {
          for (let i = 36; i < 166; i++)
            insert.run(
              `${sourceId}-${i}`,
              sourceId,
              i,
              'transcript',
              JSON.stringify({
                type: 'FragmentSelector',
                value: `t=${360 + (i - 36) * 60},${408 + (i - 36) * 60}`,
                speaker: 'S02',
                personId
              }),
              '［老李］' + '老李明天准备预算表，把三个必填字段写清楚。'.repeat(8),
              `long-${i}`,
              Date.now(),
              Date.now()
            )
        })()
      } finally {
        db.close()
      }
    },
    { sourceId, personId: personIds[1] }
  )
  env.state.respond = (kind, prompt) => {
    if (kind === 'final') {
      const data = JSON.parse(prompt) as { items: { id: string; evidence: string[] }[] }
      return {
        order: ['invented', ...data.items.map((i) => i.id).reverse()],
        summary: { title: '伪造汇总', body: '宇宙飞船已经成功发射到木星。', evidence: data.items[0].evidence.slice(0, 1) }
      }
    }
    if (kind !== 'meeting') return undefined
    const data = /<transcript_data>\s*([\s\S]*?)\s*<\/transcript_data>/.exec(prompt)!
    const ref = /^\[(u\d+)/.exec(String(JSON.parse(data[1])))![1]
    return {
      topic: { title: '预算', body: '预算流程', evidence: [ref] },
      agendas: [],
      decisions: [],
      questions: [],
      risks: [],
      progress: [],
      actions: [{ title: '预算表', body: '准备预算表，把三个必填字段写清楚。', evidence: [ref], owner: 'S02' }]
    }
  }
  try {
    const before = env.requests.length,
      d = await runLens(env, sourceId, 'lens-meeting')
    expect(d.stats!.segments).toBeGreaterThan(1)
    expect(d.stats!.segmentMs).toHaveLength(d.stats!.segments)
    expect(env.requests.slice(before).filter((r) => r.kind === 'meeting')).toHaveLength(d.stats!.segments)
    expect(env.requests.slice(before).filter((r) => r.kind === 'final')).toHaveLength(1)
    expect(d.result!.items).toHaveLength(2)
    expect(d.result!.items[0].category).toBe('action')
    expect(d.result!.items[0].evidence.length).toBeGreaterThan(1)
    expect(d.stats!.dropped.some((x) => x.itemId === 'summary' && x.reason === 'irrelevant')).toBe(true)
    expect(d.summary).not.toContain('宇宙飞船')
    env.state.blocked = true
    const count = env.requests.length
    const running = await env.page.evaluate((sourceId) => window.jiwei.lenses.run({ sourceId, lens: 'lens-meeting' }), sourceId)
    await expect.poll(() => env.requests.length).toBe(count + 1)
    await env.page.evaluate((id) => window.jiwei.sources.update(id, { aiExcluded: true }), sourceId)
    env.state.blocked = false
    env.state.release?.()
    await expect
      .poll(() =>
        env.page.evaluate(({ sourceId, id }) => window.jiwei.lenses.history(sourceId).then((ds) => ds.find((d) => d.id === id)?.status), {
          sourceId,
          id: running.id
        })
      )
      .toBe('failed')
    expect(env.requests.length).toBe(count + 1)
  } finally {
    env.state.respond = null
    env.state.blocked = false
    env.state.release?.()
  }
})

test('高峰错峰整理真实持久化 runAfter，取消后不调用服务商', async () => {
  const { sourceId } = await seedTranscript(env, 'meeting')
  const previous = await env.page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai))
  const peak = Date.UTC(2026, 9, 12, 1, 30),
    start = Date.UTC(2026, 9, 12, 4)
  const originalNow = await env.app.evaluate(() => {
    const original = Date.now.toString()
    return original
  })
  expect(originalNow).toContain('native code')
  await env.app.evaluate((_, peak) => {
    Reflect.defineProperty(Date, 'lensOriginalNow', { value: Date.now, configurable: true })
    Date.now = () => peak
  }, peak)
  try {
    await env.page.evaluate(
      async (ai) => window.jiwei.settings.set({ ai: { ...ai, chat: { ...ai.chat, model: 'deepseek-v4-flash' } } }),
      previous
    )
    const count = env.requests.length
    const estimate = await env.page.evaluate((id) => window.jiwei.lenses.estimate(id), sourceId)
    expect(estimate).toMatchObject({ offPeak: true, runAfter: start })
    expect(estimate.cost).toBeGreaterThan(0)
    const d = await env.page.evaluate((sourceId) => window.jiwei.lenses.run({ sourceId, lens: 'lens-meeting', offPeak: true }), sourceId)
    expect(d.status).toBe('queued')
    expect(d.runAfter).toBe(start)
    await expect
      .poll(() => env.page.evaluate((id) => window.jiwei.jobs.list().then((js) => js.find((j) => j.id === id)?.status), d.jobId!))
      .toBe('queued')
    await expect
      .poll(() =>
        env.app.evaluate(({ app }, id) => {
          const path = process.getBuiltinModule('path'),
            req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json')),
            Database = req('better-sqlite3') as typeof import('better-sqlite3'),
            db = new Database(path.join(app.getPath('userData'), 'data/jiwei.db'), { readonly: true })
          try {
            return (db.prepare('SELECT run_after AS runAfter FROM jobs WHERE id=?').get(id) as { runAfter: number } | undefined)?.runAfter
          } finally {
            db.close()
          }
        }, d.jobId!)
      )
      .toBe(start)
    await env.page.evaluate((id) => window.jiwei.jobs.cancel(id), d.jobId!)
    await expect
      .poll(() => env.page.evaluate((id) => window.jiwei.lenses.history(id).then((ds) => ds[0].status), sourceId))
      .toBe('canceled')
    expect(env.requests.length).toBe(count)
  } finally {
    await env.app.evaluate(() => {
      Date.now = Reflect.get(Date, 'lensOriginalNow') as typeof Date.now
      Reflect.deleteProperty(Date, 'lensOriginalNow')
    })
    await env.page.evaluate((ai) => window.jiwei.settings.set({ ai }), previous)
  }
})
