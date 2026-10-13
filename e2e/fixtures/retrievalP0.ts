/** P0 自编语料：只用于本地技术验证，不请求搜索或模型厂商。 */
const paragraph = (i: number): string =>
  `P0 paragraph ${i}: Controlled retrieval preserves visible evidence, paragraph boundaries and reproducible character positions. ` +
  'A reader should inspect the source before using its dates or conclusions. '.repeat(3)

export const P0_PARAGRAPHS = Array.from({ length: 60 }, (_, i) => paragraph(i))
const body = P0_PARAGRAPHS.slice(0, 5)
  .map((p) => `<p>${p}</p>`)
  .join('')
const shell = (content: string): string =>
  `<html lang="en"><head><title>P0 controlled document</title><meta property="og:title" content="P0 title"></head><body>${content}</body></html>`

export const P0_PAGES: Record<string, string> = {
  '/article': shell(`<article><h1>P0 article</h1>${body}</article>`),
  '/list': shell(
    `<main><h1>P0 directory</h1><ul>${P0_PARAGRAPHS.slice(0, 5)
      .map((p) => `<li>${p}</li>`)
      .join('')}</ul></main>`
  ),
  '/js': shell(
    `<main id="content"></main><script>setTimeout(() => { document.getElementById('content').innerHTML = ${JSON.stringify(`<article><h1>JS_RENDERED_MARKER</h1>${body}</article>`)} }, 100)</script>`
  ),
  '/hidden': shell(
    `<article>${body}<p hidden>HIDDEN_MARKER</p><p aria-hidden="true">ARIA_MARKER</p><p style="DISPLAY: none">INLINE_MARKER</p><p style="visibility: HIDDEN">VISIBILITY_MARKER</p><p style="font-size: 0px">ZERO_MARKER</p><script>/* SCRIPT_MARKER */</script></article>`
  )
}

export const P0_PDF_LINES = P0_PARAGRAPHS.slice(0, 4).map((p) => p.slice(0, 90))
