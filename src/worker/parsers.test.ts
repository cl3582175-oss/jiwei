import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseHtml } from './parsers'

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

describe('saved HTML visible text', () => {
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
      text: 'Results follow. Evidence Method Result Bayesian 0.05 Control Not significant Qualifications remain.'
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
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].text).toBe(text)
  })

  it('locates an unchanged native quote spanning visible blocks in the same source segment', async () => {
    const result = await parseArticle('<p>Prior context.</p><p>First visible evidence.</p><ul><li>Conditional material.</li></ul><table><tr><td>Numerical result: 0.05.</td></tr></table><p>Final qualification.</p><p>Following context.</p>')
    const quote = 'First visible evidence. Conditional material. Numerical result: 0.05. Final qualification.'
    const start = result.segments[0].text.indexOf(quote)
    expect(start).toBe(15)
    expect(result.segments[0].text.slice(start, start + quote.length)).toBe(quote)
  })
})
