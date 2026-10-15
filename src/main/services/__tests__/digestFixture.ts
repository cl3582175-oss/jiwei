import { afterEach, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'

const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  model: null as MockLanguageModelV4 | null,
  calls: [] as string[],
  events: [] as { name: string; payload: Record<string, unknown> }[],
  beforeOutput: (_prompt: string, _map: boolean): void => {}
}))
export { f }
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../events', () => ({ emit: (name: string, payload: Record<string, unknown>) => f.events.push({ name, payload }) }))
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../device', () => ({ deviceId: () => 'controlled' }))
vi.mock('../stats', () => ({ recordActivity: () => {} }))
vi.mock('../docs', () => ({ initDoc: () => {}, replaceDoc: () => {} }))
vi.mock('../review', () => ({ syncCards: () => {} }))
vi.mock('../memoryLearn', () => ({ recordProposalDecision: () => {} }))
vi.mock('../recordingContext', () => ({ lensMessage: (s: string) => s }))
vi.mock('../connections', () => ({ relate: () => {} }))
vi.mock('../settings', () => ({ getSettings: () => ({ language: 'zh-CN', money: {} }) }))
vi.mock('../ai/model', () => ({ buildModel: () => ({ model: f.model!, maxOutputTokens: 8192 }) }))
vi.mock('../ai/providers', () => ({ getProviderRow: () => ({ modelCaps: '{}', models: '["controlled"]' }) }))
vi.mock('../ai/tools', () => ({ buildMindmap: vi.fn(), NestedSchema: {} }))
vi.mock('../agent/pricing', () => ({ costOf: () => ({ cost: null }) }))

export const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 }
}
function output(opts: LanguageModelV4CallOptions) {
  const prompt = opts.prompt
    .filter((p) => p.role === 'user')
    .map((p) => JSON.stringify(p.content))
    .join('\n')
  const map = /\[[^\]]+\]/.test(prompt) && !prompt.includes('## 1.')
  f.calls.push(prompt)
  f.beforeOutput(prompt, map)
  const id = /\[([^\s\]]+)/.exec(prompt)?.[1] ?? ''
  const markdown = '# 总结\n\n' + '这是一份用于验证后台任务真实落库路径的受控总结，包含核心结论与解释。'.repeat(3)
  const result = map ? { topic: '主题', points: [{ text: '核心要点', segmentId: id }] } : { markdown }
  return opts.tools?.some((t) => t.type === 'function' && t.name === 'submit')
    ? { type: 'tool-call' as const, toolCallId: 'submit-1', toolName: 'submit', input: JSON.stringify(result) }
    : { type: 'text' as const, text: map ? `# 主题\n- 核心要点 {${id}}` : markdown }
}

beforeEach(() => {
  vi.useFakeTimers()
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  for (const file of readdirSync(join(process.cwd(), 'resources/migrations'))
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(process.cwd(), 'resources/migrations', file), 'utf8'))
  f.db = drizzle(f.sql)
  f.calls = []
  f.events = []
  f.beforeOutput = () => {}
  f.model = new MockLanguageModelV4({
    doGenerate: async (opts) => ({ content: [output(opts)], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
    doStream: async (opts) => {
      const part = output(opts)
      const chunks: LanguageModelV4StreamPart[] =
        part.type === 'tool-call'
          ? [part]
          : [
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: part.text },
              { type: 'text-end', id: 'text' }
            ]
      return {
        stream: new ReadableStream({
          start(c) {
            for (const part of chunks) c.enqueue(part)
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage })
            c.close()
          }
        })
      }
    }
  })
  f.sql.exec("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('own','own',1,1),('other','other',1,1)")
})
afterEach(async () => {
  const { stopJobsAndWait } = await import('../jobs')
  await stopJobsAndWait()
  vi.clearAllTimers()
  vi.useRealTimers()
  f.sql?.close()
})

export async function source(attachment = true, count = 1): Promise<string[]> {
  f.sql!.prepare(
    "INSERT INTO sources(id,title,kind,space,ai_excluded,created_at,accessed_at,updated_at,updated_by) VALUES('source','Controlled source','document',?,?,1,1,1,'controlled')"
  ).run(attachment ? 'attachment' : 'library', Number(attachment))
  if (attachment) f.sql!.exec("INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('own','source',1)")
  const { replaceSegments, listSegments } = await import('../segments')
  replaceSegments(
    'source',
    Array.from({ length: count }, (_, i) => ({ kind: 'text' as const, text: `part-${i + 1} ` + 'a'.repeat(6000), locator: {} }))
  )
  return listSegments('source').map((s) => s.id)
}

export async function start(noteId?: string) {
  const { registerDigestJob, startDigest } = await import('../digest')
  const { startJobs } = await import('../jobs')
  registerDigestJob()
  startJobs()
  return startDigest({ sourceId: 'source', conversationId: 'own', task: 'summary', providerId: 'controlled', model: 'controlled', noteId })
}

export async function settle(jobId: string) {
  for (let n = 0; n < 1000; n++) {
    await vi.advanceTimersByTimeAsync(1000)
    const row = f.sql!.prepare('SELECT status,result,error FROM jobs WHERE id=?').get(jobId) as {
      status: string
      result: string | null
      error: string | null
    }
    if (['done', 'failed'].includes(row.status)) return row
  }
  throw new Error('Controlled job did not settle')
}
