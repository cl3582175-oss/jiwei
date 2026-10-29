import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import type { Scene } from '../../src/shared/recording'
import type { Derivation, LensItem } from '../../src/shared/lens'
import { navTo } from './nav'
import { writeOpenAiCompletion } from './openaiResponse'
export interface TranscriptFixture {
  title: string
  scene: Scene
  startedAt: string
  speakers: { label: string; name: string }[]
  lines: string[]
}
export const transcriptFixture = (kind: 'meeting' | 'lecture' | 'thought'): TranscriptFixture =>
  JSON.parse(readFileSync(resolve(`e2e/fixtures/lens-${kind}.json`), 'utf8')) as TranscriptFixture
export interface LensApp {
  app: ElectronApplication
  page: Page
  userData: string
  provider: Server
  requests: { prompt: string; kind: string }[]
  state: {
    confidence: number
    blocked: boolean
    release: (() => void) | null
    fail: boolean
    respond: ((kind: string, prompt: string) => unknown) | null
  }
  close: () => Promise<void>
}
const entry = (title: string, body: string, evidence: string[], extra: Record<string, unknown> = {}) => ({
  title,
  body,
  evidence,
  ...extra
})
export function controlledOutput(kind: string, prompt: string): unknown {
  if (kind === 'scene')
    return {
      scene: prompt.includes('提取练习') ? 'lecture' : prompt.includes('猜想') ? 'thought' : 'meeting',
      confidence: 0.9,
      reason: '受控流程夹具，不是语义证据'
    }
  if (kind === 'meeting')
    return {
      topic: entry('预算流程会议', '预算流程和下周试用安排', ['u1']),
      agendas: [entry('老李的意见', '老李认为预算审批时间太长，应该先简化表格。', ['u4'], { speaker: 'S02' })],
      decisions: [entry('试用决定', '决定下周试用新的预算流程，只在研发组试用一周。', ['u7'], { speaker: 'S01' })],
      actions: [
        entry('准备预算表', '老李明天准备预算表，把三个必填字段写清楚。', ['u11'], { owner: 'S02', dueQuote: '明天' }),
        entry('编造引用', '宇宙飞船已经成功发射', ['u999'])
      ],
      questions: [entry('待定问题', '预算额度和培训安排仍然是待定问题。', ['u20'])],
      risks: [],
      progress: []
    }
  if (kind === 'lecture')
    return {
      course: '学习方法课',
      lecture: '第2讲',
      outline: [],
      concepts: [entry('间隔重复', '间隔重复是把复习分散到不同时间，而不是一天全部重复。', ['u5'])],
      examples: [],
      emphasis: [
        entry('复习重点', '在快要遗忘时复习，这是本次考试的重点。', ['u21'], {
          quote: '在快要遗忘时复习，这是本次考试的重点。',
          cue: '什么时候复习？'
        })
      ],
      qa: [],
      assignments: [entry('作业', '写四个线索问题，下周三之前提交。', ['u27'], { owner: 'S02', dueQuote: '下周三之前' })],
      rows: [
        entry('间隔重复', '把复习分散到不同时间，而不是一天全部重复。', ['u5'], { cue: '间隔重复是什么？' }),
        entry('提取练习', '合上材料，主动尝试回忆学过的知识。', ['u9'], { cue: '提取练习怎么做？' }),
        entry('交错练习', '交替练不同类型的问题，帮助判断该用哪种方法。', ['u13'], { cue: '交错练习有什么作用？' }),
        entry('康奈尔笔记', '线索栏写问题，笔记栏写相应的要点和答案。', ['u17'], { cue: '康奈尔两栏怎么写？' })
      ]
    }
  if (kind === 'thought')
    return {
      paragraphs: [
        entry('能继续思考的笔记', '我想把学习笔记变成能继续思考的地方。', ['u1'], { quote: '我想把学习笔记变成能继续思考的地方。' })
      ],
      ideas: [entry('留下问题', '我猜，在笔记里留下一个没解决的问题，可能更容易让我回来。', ['u6'])],
      questions: [entry('值得继续的问题', '怎样区分值得继续的问题和随手记下的疑问？', ['u16'])],
      plans: [entry('三篇笔记的小实验', '下周三整理三篇最近的笔记，试着各留一个问题。', ['u24'], { dueQuote: '下周三' })],
      links: []
    }
  const transcript = /<transcript_data>\s*([\s\S]*?)\s*<\/transcript_data>/.exec(prompt)
  const lines = transcript ? String(JSON.parse(transcript[1])).split('\n') : []
  const body = lines[0]?.replace(/^\[[^\]]+\]\s*/, '') || '预算流程和下周试用安排'
  if (kind === 'brief')
    return { sentences: lines.slice(0, 3).map((line, i) => entry(`句${i + 1}`, line.replace(/^\[[^\]]+\]\s*/, ''), [`u${i + 1}`])) }
  if (kind === 'final') {
    const data = JSON.parse(prompt.split('\n').at(-1)!) as { items: LensItem[] }
    return { order: [...data.items.map((i) => i.id), 'invented'], summary: entry('整体摘要', data.items[0].body, data.items[0].evidence) }
  }
  return { items: [entry('自定义整理', body, ['u1'], { category: 'item' })] }
}
export async function startLensApp(options: { provider?: boolean; importProviders?: string } = {}): Promise<LensApp> {
  const requests: LensApp['requests'] = [],
    state: LensApp['state'] = { confidence: 0.9, blocked: false, release: null, fail: false, respond: null }
  const provider = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      void (async () => {
        try {
          const input = JSON.parse(body) as {
            messages: { role: string; content: string | null }[]
            stream?: boolean
            tools?: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[]
          }
          const submit = input.tools?.find((t) => t.function.name === 'submit'),
            props = submit?.function.parameters.properties ?? {},
            prompt = input.messages.map((m) => m.content ?? '').join('\n'),
            user = input.messages
              .filter((m) => m.role === 'user')
              .map((m) => m.content ?? '')
              .join('\n')
          const kind =
            'confidence' in props
              ? 'scene'
              : 'topic' in props
                ? 'meeting'
                : 'course' in props
                  ? 'lecture'
                  : 'paragraphs' in props
                    ? 'thought'
                    : 'sentences' in props
                      ? 'brief'
                      : 'order' in props
                        ? 'final'
                        : 'items'
          requests.push({ kind, prompt })
          if (state.blocked) await new Promise<void>((resolve) => (state.release = resolve))
          if (state.fail) {
            response.writeHead(503).end('Controlled transport failure')
            return
          }
          const output =
            state.respond?.(kind, kind === 'final' ? user : prompt) ??
            (kind === 'scene'
              ? { ...(controlledOutput(kind, prompt) as Record<string, unknown>), confidence: state.confidence }
              : controlledOutput(kind, kind === 'final' ? user : prompt))
          writeOpenAiCompletion(response, {
            id: `lens-${requests.length}`,
            object: 'chat.completion',
            created: 1,
            model: 'lens-transport-fixture',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: `submit-${requests.length}`,
                      type: 'function',
                      function: { name: 'submit', arguments: JSON.stringify(output) }
                    }
                  ]
                },
                finish_reason: 'tool_calls'
              }
            ],
            usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
          }, !!input.stream)
        } catch {
          response.writeHead(400).end('Invalid fixture request')
        }
      })()
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-lenses-'))
  const app = await electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: options.importProviders ?? '' }
    }),
    page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ app }, dir) => app.setPath('appData', dir), mkdtempSync(join(tmpdir(), 'jiwei-lens-models-')))
  if (options.provider !== false) {
    const url = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
    await page.evaluate(async (url) => {
      const p = await window.jiwei.providers.save({
          kind: 'ollama',
          name: 'Lens transport fixture',
          baseUrl: url,
          models: ['lens-transport-fixture'],
          modelCaps: { 'lens-transport-fixture': { tier: 'basic', vision: false } }
        }),
        s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...s.ai,
          chat: { providerId: p.id, model: 'lens-transport-fixture' },
          embedding: { mode: 'cloud', providerId: null, model: null },
          effort: 'off'
        },
        theme: 'light'
      })
    }, url)
  }
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
  await page.reload()
  await page.waitForSelector('nav')
  return {
    app,
    page,
    userData,
    provider,
    requests,
    state,
    close: async () => {
      state.release?.()
      await app.close()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
    }
  }
}
export async function seedTranscript(
  env: LensApp,
  kind: 'meeting' | 'lecture' | 'thought',
  opts: { scene?: Scene; local?: boolean; audio?: boolean; noteId?: string; seriesId?: string; title?: string } = {}
): Promise<{ sourceId: string; personIds: string[] }> {
  const fixture = transcriptFixture(kind),
    sourceId = randomUUID(),
    personIds = await env.page.evaluate(
      async (people) =>
        Promise.all(people.map((p) => window.jiwei.people.save({ name: p.name, note: '测试人员，仅用于本地转写夹具' }).then((p) => p.id))),
      fixture.speakers
    )
  await env.app.evaluate(
    ({ app }, { fixture, sourceId, personIds, opts, kind }) => {
      const path = process.getBuiltinModule('path'),
        fs = process.getBuiltinModule('fs'),
        req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json')),
        Database = req('better-sqlite3') as typeof import('better-sqlite3'),
        db = new Database(path.join(app.getPath('userData'), 'data/jiwei.db')),
        personal = new Database(path.join(app.getPath('userData'), 'profile/memory.db')),
        now = Date.now(),
        at = Date.parse(fixture.startedAt)
      try {
        db.prepare(
          'INSERT INTO sources (id,title,kind,accessed_at,ai_excluded,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)'
        ).run(sourceId, opts.title ?? fixture.title, 'recording', at, opts.local ? 1 : 0, now, now, 'e2e')
        db.prepare(
          'INSERT INTO recordings (id,source_id,note_id,scene,series_id,status,tracks,started_at,duration_ms,markers,participants,local_only,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
          sourceId,
          sourceId,
          opts.noteId ?? null,
          opts.scene ?? fixture.scene,
          opts.seriesId ?? null,
          'ready',
          '["mic"]',
          at,
          fixture.lines.length * 10000,
          '[{"t":60,"kind":"decision","text":"试用范围"}]',
          JSON.stringify(personIds),
          opts.local ? 1 : 0,
          now,
          now,
          'e2e'
        )
        fixture.lines.forEach((text, i) => {
          const personIndex = kind === 'meeting' && i === 3 ? 1 : i % fixture.speakers.length,
            speaker = fixture.speakers[personIndex],
            personId = personIds[personIndex]
          db.prepare(
            'INSERT INTO source_segments (id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
          ).run(
            `${sourceId}-${i}`,
            sourceId,
            i,
            'transcript',
            JSON.stringify({ type: 'FragmentSelector', value: `t=${i * 10},${i * 10 + 8}`, speaker: speaker.label, personId }),
            `［${speaker.name}］${text}`,
            `fixture-${i}`,
            now,
            now
          )
        })
        fixture.speakers.forEach((s, i) =>
          personal
            .prepare('INSERT INTO recording_speakers (source_id,label,person_id,origin) VALUES (?,?,?,?)')
            .run(sourceId, s.label, personIds[i], 'user')
        )
        if (opts.audio) {
          const folder = path.join(app.getPath('userData'), 'data', 'recordings', sourceId)
          fs.mkdirSync(folder, { recursive: true })
          fs.copyFileSync(path.join(app.getAppPath(), 'e2e/fixtures/meeting.wav'), path.join(folder, 'mix.webm'))
        }
      } finally {
        db.close()
        personal.close()
      }
    },
    { fixture, sourceId, personIds, opts, kind }
  )
  return { sourceId, personIds }
}
export async function openTranscript(env: LensApp, title: string): Promise<void> {
  await navTo(env.page, /资料库/)
  await env.page.getByText(title, { exact: true }).dblclick()
  await expect(env.page.getByTestId('dialogue-transcript')).toBeVisible()
}
export async function runLens(env: LensApp, sourceId: string, lens: string, timeout = 30000): Promise<Derivation> {
  const run = await env.page.evaluate(({ sourceId, lens }) => window.jiwei.lenses.run({ sourceId, lens }), { sourceId, lens })
  await expect
    .poll(
      () =>
        env.page.evaluate(({ sourceId, id }) => window.jiwei.lenses.history(sourceId).then((ds) => ds.find((d) => d.id === id)?.status), {
          sourceId,
          id: run.id
        }),
      { timeout }
    )
    .toBe('ready')
  return env.page.evaluate(({ sourceId, id }) => window.jiwei.lenses.history(sourceId).then((ds) => ds.find((d) => d.id === id)!), {
    sourceId,
    id: run.id
  })
}
export async function lensShot(env: LensApp, name: string): Promise<void> {
  if (!process.env.SHOTS_DIR) return
  mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await expect
    .poll(() =>
      env.page
        .locator('button')
        .evaluateAll(
          (buttons) =>
            buttons
              .flatMap((b) => b.getAnimations())
              .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length
        )
    )
    .toBe(0)
  await env.page.screenshot({ path: join(process.env.SHOTS_DIR, name) })
}
export async function setLensTheme(env: LensApp, theme: 'light' | 'dark'): Promise<void> {
  await env.page.getByRole('button', { name: /^设置/ }).click()
  const dialog = env.page.getByRole('dialog')
  await dialog.getByRole('tab', { name: '外观', exact: true }).click()
  await dialog.getByRole('radio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect.poll(() => env.page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
  await env.page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
}
