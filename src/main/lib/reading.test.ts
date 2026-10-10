import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { readingCacheKey, lruVictims, cleanReadingHtml } from './reading'
import { readingBatches, readingParts, readingLanguage, ReadingBatchSchema, readingParagraphs, originalReadingText } from '@shared/reading'

describe('reading integrity and cache', () => {
  it('removes all UI before extraction while retaining original nodes', () => {
    const html = '<html><head><style data-jiwei-ui>p:has(+jiwei-reading){display:none}</style></head><body><main><p>Original terminology.</p><jiwei-reading data-jiwei-ui>译文</jiwei-reading><div data-jiwei-ui>gloss</div></main></body></html>'
    const cleaned = cleanReadingHtml(html)
    const { document } = parseHTML(cleaned)
    expect(document.querySelectorAll('[data-jiwei-ui]').length).toBe(0)
    expect(document.querySelector('p')?.textContent).toBe('Original terminology.')
    expect(document.body.textContent).not.toContain('译文')
  })
  it('shares hashes across sources and normalization, separates language/style/gloss context', () => {
    expect(readingCacheKey(' A\n sentence. ', 'zh', 'v1')).toBe(readingCacheKey('A sentence.', 'zh', 'v1'))
    expect(readingCacheKey('A sentence.', 'zh', 'v1')).not.toBe(readingCacheKey('A sentence.', 'en', 'v1'))
    expect(readingCacheKey('A sentence.', 'zh', 'v1')).not.toBe(readingCacheKey('A sentence.', 'zh', 'v2'))
    expect(readingCacheKey('A sentence.', 'zh', 'v1', 'sentence')).not.toBe(readingCacheKey('Another sentence.', 'zh', 'v1', 'sentence'))
  })
  it('evicts least recently used entries until below byte budget', () => {
    expect(lruVictims([{ id:'new',bytes:8,usedAt:3 },{ id:'old',bytes:7,usedAt:1 },{ id:'mid',bytes:2,usedAt:2 }], 10)).toEqual(['old'])
  })
  it('splits real PDF segments and limits each viewport batch', () => {
    const paragraphs = readingParts('word '.repeat(1500)).map((text, i) => ({ id:`page:${i}`,text }))
    expect(paragraphs.every((p) => p.text.length <= 2400)).toBe(true)
    const batches = readingBatches([...paragraphs,...Array.from({length:50},(_,i)=>({id:`p${i}`,text:'Short paragraph.'}))])
    expect(batches.every((b) => b.length <= 20 && b.reduce((n,p)=>n+p.text.length,0)<=3000)).toBe(true)
    expect(ReadingBatchSchema.safeParse({target:{kind:'source',id:'src'},paragraphs:[{id:'p1',text:'x'.repeat(2000)},{id:'p2',text:'x'.repeat(2000)}],translation:true,annotations:true,targetLanguage:'zh'}).success).toBe(false)
  })
  it('checks language tags against actual CJK content', () => {
    expect(readingLanguage('这是中文网页主要正文，介绍算法和学习。','en')).toBe('zh')
    expect(readingLanguage('An English research article about learning.','zh')).toBe('en')
    expect(readingLanguage('Une étude des fonctions.','fr-FR')).toBe('fr')
  })
  it('filters hidden, navigation, code, formulas, UI and duplicate nested paragraphs',()=>{
    const {document}=parseHTML('<html><body><nav><p>Navigation links</p></nav><p hidden>Hidden login</p><pre><p>Code block</p></pre><p class="katex">Math formula</p><div data-jiwei-ui><p>Translation words</p></div><li><p>One original paragraph</p></li><p>Second paragraph <span data-jiwei-ui>释义</span></p></body></html>')
    const paragraphs=readingParagraphs(document)
    expect(paragraphs.map(originalReadingText)).toEqual(['One original paragraph','Second paragraph '])
  })
})
