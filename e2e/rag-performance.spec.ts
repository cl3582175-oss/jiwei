import { test, expect } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { LOCAL_EMBEDDING } from '../src/shared/ai'
import { percentile } from './fixtures/ragMetrics'

test.skip(process.env.JIWEI_RAG_PERF !== '1', '显式运行五万段本地向量整次检索性能')
test('50000 segments measure full production retrieve including fresh query embeddings', async () => {
  test.setTimeout(300_000)
  const resultDir = resolve(process.env.JIWEI_RAG_EVAL!, 'results')
  const rel = relative(resolve('.'), resultDir)
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Performance output must be outside the repository')
  const directory = mkdtempSync(join(tmpdir(), 'rag-v0145-performance-'))
  const app = await launchRagApp(directory)
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await page.evaluate(() => window.jiwei.settings.set({ retrieval: { autoUpgrade: false } }))
    await page.evaluate(() => window.jiwei.embedding.installLocal())
    const status = await page.evaluate(() => window.jiwei.embedding.status())
    expect(status.state).toBe('ready')
    await app.evaluate(
      ({ app }, { directory, model }) => {
        if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
        const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json')
        const db = new (loader('better-sqlite3'))(directory + '/data/jiwei.db')
        db.loadExtension(loader('sqlite-vec').getLoadablePath())
        const s = db.prepare(
          "INSERT INTO sources(id,title,kind,parse_version,accessed_at,created_at,updated_at) VALUES(?,?,'document',2,1,1,1)"
        )
        const g = db.prepare(
          "INSERT INTO source_segments(id,source_id,ordinal,kind,text,heading,hash,locator,created_at,updated_at) VALUES(?,?,?,'paragraph',?,?,?,'{}',1,1)"
        )
        const c = db.prepare(
          "INSERT INTO chunks(owner_type,owner_id,parent_type,parent_id,hash,model,created_at) VALUES('segment',?,'source',?,?,?,1) RETURNING rowid"
        )
        const v = db.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)')
        db.transaction(() => {
          for (let i = 0; i < 50; i++) s.run('perf-' + i, 'Synthetic perf source ' + i)
          for (let i = 0; i < 50000; i++) {
            const id = 'perf-seg-' + i,
              parent = 'perf-' + Math.floor(i / 1000)
            const text =
              `合成节拍设备 ZX-${i} 的维护周期与验收条件应保留完整证据。` + '温度与压力分别记录，连续运行时检查紧固件和冷却液。'.repeat(8)
            g.run(id, parent, i % 1000, text, '第二章 维护', id)
            const row = c.get(id, parent, id, model) as { rowid: number }
            const a = new Float32Array(512)
            a[i % 512] = 0.8
            a[(i + 1) % 512] = 0.6
            v.run(BigInt(row.rowid), Buffer.from(a.buffer))
          }
        })()
        db.close()
      },
      { directory, model: LOCAL_EMBEDDING.id }
    )
    const queries = [
      { query: '节拍', scope: { type: 'all' as const } },
      { query: '“ZX-420” 的维护条件', scope: { type: 'all' as const } },
      { query: '温度与压力应怎样记录', scope: { type: 'all' as const } },
      { query: '节拍', scope: { type: 'items' as const, sources: ['perf-8', 'perf-9'], notes: [] } },
      {
        query: '冷却液与连续运行',
        scope: { type: 'items' as const, sources: Array.from({ length: 21 }, (_, i) => 'perf-' + i), notes: [] }
      }
    ]
    const timings: { case: number; ms: number; count: number }[] = []
    for (let pass = 0; pass < 7; pass++)
      for (const [index, q] of queries.entries()) {
        const start = performance.now()
        const hits = await page.evaluate((q) => window.jiwei.knowledge.search(q.query, q.scope, 8), q)
        const ms = performance.now() - start
        if (pass > 0) timings.push({ case: index, ms, count: hits.length })
        if (q.scope.type === 'items') {
          const ids = q.scope.sources
          expect(hits.every((h) => ids.includes(h.parentId))).toBe(true)
        }
      }
    const metrics = {
      p50: percentile(
        timings.map((t) => t.ms),
        0.5
      ),
      p95: percentile(
        timings.map((t) => t.ms),
        0.95
      )
    }
    mkdirSync(resultDir, { recursive: true })
    writeFileSync(
      join(resultDir, `performance-${process.env.JIWEI_RAG_STAGE ?? 'p4'}-${Date.now()}.json`),
      JSON.stringify(
        {
          segments: 50000,
          dimensions: 512,
          queryEmbedding: 'real local; measured inside IPC roundtrip',
          warmups: 5,
          timings,
          metrics,
          byCase: queries.map((q, i) => ({
            query: q.query,
            scope: q.scope.type,
            p50: percentile(
              timings.filter((t) => t.case === i).map((t) => t.ms),
              0.5
            ),
            p95: percentile(
              timings.filter((t) => t.case === i).map((t) => t.ms),
              0.95
            )
          }))
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ segments: 50000, ...metrics }))
    expect(metrics.p95).toBeLessThanOrEqual(800)
  } finally {
    await app.close()
  }
})
