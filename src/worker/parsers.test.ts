import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseHtml } from './parsers'
import { marked } from 'marked'
import { readingHtmlText } from '../main/lib/reading'
import { normalizeQuery } from '../main/lib/textNormalize'

async function parseArticle(body: string): Promise<Awaited<ReturnType<typeof parseHtml>>> {
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-html-parser-'))
  try {
    const path = join(dir, 'article.html')
    await writeFile(path, `<html><head><title>Boundary parsing</title></head><body><article>${body}</article></body></html>`)
    return await parseHtml(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const visibleText = (segments: Awaited<ReturnType<typeof parseHtml>>['segments']): string =>
  normalizeQuery(
    readingHtmlText(
      marked.parse(
        segments.map((s, i) => `${s.heading && s.heading !== segments[i - 1]?.heading ? s.heading + '\n\n' : ''}${s.text}`).join('\n\n'),
        { async: false }
      )
    )
  )

describe('saved HTML visible text', () => {
  it('keeps the section path and normalizes extracted text at the registered parser entry', async () => {
    const result = await parseArticle('<h2>第二章 条件</h2><p>⻛压Ａ１０２必须稳定。</p>')
    expect(result.segments[0]).toMatchObject({ heading: '第二章 条件', text: '风压A102必须稳定。' })
  })
  it.each([
    {
      name: 'adjacent headings, paragraphs and lists',
      html: '<h2>Knowledge</h2><p>First evidence.</p><p>Second evidence.</p><ul><li>Observation one.</li><li>Observation two.</li></ul>',
      text: 'Knowledge First evidence. Second evidence. Observation one. Observation two.'
    },
    {
      name: 'BR boundaries without literal source whitespace',
      html: '<p>First line.<br>Second line.<br><br>Third line.</p>',
      text: 'First line. Second line. Third line.'
    },
    {
      name: 'table captions, rows and cells',
      html: '<p>Results follow.</p><table><caption>Evidence</caption><thead><tr><th>Method</th><th>Result</th></tr></thead><tbody><tr><td>Bayes<em>ian</em></td><td>0.05</td></tr><tr><td>Control</td><td>Not significant</td></tr></tbody></table><p>Qualifications remain.</p>',
      text: 'Results follow. Evidence Method：Bayesian；Result：0.05 Method：Control；Result：Not significant Qualifications remain.'
    },
    {
      name: 'inline continuity, formulas, numbers and negation',
      html: '<p>Heuri<em>stic</em> multi<strong>word</strong> reasoning does <b>not</b> imply α² ≤ 0.05 or p ≠ 0.</p><pre><code>n !== 2</code></pre><p>Only if evidence holds.</p>',
      text: 'Heuristic multiword reasoning does not imply α² ≤ 0.05 or p ≠ 0. n !== 2 Only if evidence holds.'
    },
    {
      name: 'ordinary formatting whitespace',
      html: '\n  <p>First\n  empirical evidence.</p>\n  <p>Second\t observation.</p>\n',
      text: 'First empirical evidence. Second observation.'
    }
  ])('retains $name in the canonical source text', async ({ html, text }) => {
    const result = await parseArticle(html)
    expect(result.title).toBe('Boundary parsing')
    expect(visibleText(result.segments)).toBe(normalizeQuery(text))
  })

  it('retains a native quote spanning visible blocks in source order after normalization', async () => {
    const result = await parseArticle(
      '<p>Prior context.</p><p>First visible evidence.</p><ul><li>Conditional material.</li></ul><table><tr><td>Numerical result: 0.05.</td></tr></table><p>Final qualification.</p><p>Following context.</p>'
    )
    const quote = 'First visible evidence. Conditional material. Numerical result: 0.05. Final qualification.'
    const visible = visibleText(result.segments)
    const start = visible.indexOf(quote)
    expect(start).toBe(15)
    expect(visible.slice(start, start + quote.length)).toBe(quote)
  })
})
