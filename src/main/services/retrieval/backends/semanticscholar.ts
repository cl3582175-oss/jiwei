import { doiUrl, jsonResponse, normalizeResults, optionalRecord, request, rows, type SearchBackend } from './common'
const fields = 'title,url,year,abstract,authors,venue,citationCount,externalIds,openAccessPdf,publicationDate'
export const semanticscholar: SearchBackend = {
  id: 'semanticscholar',
  async search(query, cred, signal) {
    const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search')
    url.searchParams.set('query', query.q)
    url.searchParams.set('limit', String(query.count))
    url.searchParams.set('fields', fields)
    const keyed = !!cred.key?.trim()
    const response = await request('semanticscholar', url.href, signal, {
      method: 'GET',
      headers: keyed ? { 'x-api-key': cred.key! } : {},
      ...(keyed ? {} : { minIntervalMs: 1100 })
    })
    return normalizeResults(
      'semanticscholar',
      rows(jsonResponse(response).data).map((row) => {
        const doi = optionalRecord(row.externalIds).DOI
        return {
          url: doiUrl(doi) ?? row.url,
          title: row.title,
          snippet: row.abstract,
          published: row.publicationDate,
          doi,
          authors: Array.isArray(row.authors) ? row.authors.map((v) => optionalRecord(v).name) : undefined,
          year: row.year,
          venue: row.venue,
          citations: row.citationCount,
          pdfUrl: optionalRecord(row.openAccessPdf).url
        }
      }),
      query.count
    )
  }
}
