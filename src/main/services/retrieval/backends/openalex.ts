import { jsonResponse, normalizeResults, optionalRecord, request, rows, type SearchBackend } from './common'
const select =
  'id,doi,display_name,publication_year,publication_date,authorships,primary_location,cited_by_count,abstract_inverted_index,open_access,best_oa_location'
function abstractText(value: unknown): string {
  // 使用 Map 排位置，避免稀疏或恶意极大位置触发无界数组分配。
  const words = new Map<number, string>()
  for (const [word, positions] of Object.entries(optionalRecord(value)))
    if (Array.isArray(positions))
      for (const position of positions)
        if (typeof position === 'number' && Number.isSafeInteger(position) && position >= 0) words.set(position, word)
  return [...words]
    .sort(([a], [b]) => a - b)
    .map(([, word]) => word)
    .join(' ')
}
export const openalex: SearchBackend = {
  id: 'openalex',
  async search(query, cred, signal) {
    const url = new URL('https://api.openalex.org/works')
    url.searchParams.set('search', query.q)
    url.searchParams.set('per_page', String(query.count))
    url.searchParams.set('select', select)
    if (cred.key?.trim()) url.searchParams.set('api_key', cred.key)
    const response = await request('openalex', url.href, signal, { method: 'GET' })
    return normalizeResults(
      'openalex',
      rows(jsonResponse(response).results).map((row) => {
        const primary = optionalRecord(row.primary_location)
        return {
          url: row.doi || primary.landing_page_url || row.id,
          title: row.display_name,
          snippet: abstractText(row.abstract_inverted_index),
          published: row.publication_date,
          doi: row.doi,
          authors: Array.isArray(row.authorships)
            ? row.authorships.map((v) => optionalRecord(optionalRecord(v).author).display_name)
            : undefined,
          year: row.publication_year,
          venue: optionalRecord(primary.source).display_name,
          citations: row.cited_by_count,
          // P0 官方文档核对：oa_url 可能是落地页，只有 pdf_url 才能标为 PDF。
          pdfUrl: optionalRecord(row.best_oa_location).pdf_url
        }
      }),
      query.count
    )
  }
}
