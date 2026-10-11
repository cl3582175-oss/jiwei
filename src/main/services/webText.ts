import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { externalFetch, checkedWebUrl } from './externalFetch'
import { getSettings } from './settings'
import { isSensitiveUrl } from '../lib/browserPolicy'

export async function fetchWebText(url: string, selector?: string, signal?: AbortSignal): Promise<{ title: string; text: string; url: string; sourceUrls: string[] }> {
  const u = checkedWebUrl(url),
    sourceUrls = [u.href]
  if (isSensitiveUrl(u.href, getSettings().browser?.aiBlockedSites ?? [])) throw new Error('This site is excluded from AI')
  const r = await externalFetch(u.href, {
    signal,
    validateUrl: (next) => {
      if (isSensitiveUrl(next, getSettings().browser?.aiBlockedSites ?? [])) throw new Error('This site is excluded from AI')
      if (!sourceUrls.includes(next)) sourceUrls.push(next)
    }
  })
  if (r.status !== 200) throw new Error(`Web fetch failed (HTTP ${r.status})`)
  const { document } = parseHTML(r.text)
  document.querySelectorAll('script,style,noscript,[data-jiwei-ui]').forEach((n) => n.remove())
  const selected = selector ? document.querySelector(selector) : null
  if (selector && !selected) throw new Error('Selector did not match')
  const parsed = !selector ? new Readability(document as unknown as Document).parse() : null
  const text = (selected?.textContent ?? parsed?.textContent ?? document.body?.textContent ?? r.text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20000)
  for (const source of sourceUrls)
    if (isSensitiveUrl(source, getSettings().browser?.aiBlockedSites ?? [])) throw new Error('This site is excluded from AI')
  return { title: document.title || u.hostname, text, url: u.href, sourceUrls }
}
