// v0.13 起已废弃，新代码用 services/retrieval。
import { SearchSave, type SearchConnection, type SearchResult, type SearchService } from '@shared/discover'
import { backendStates, saveBackend } from '../retrieval/backends/store'
import { hasWebBackend, searchWeb, testBackend } from '../retrieval/gateway'
import { discoverChanged } from './feeds'
import { tr } from '../../lib/messages'

export function searchProviders(): SearchConnection[] {
  const states = backendStates()
  return (['bocha', 'tavily', 'brave'] as const).map((service) => {
    const state = states.find((value) => value.id === service)
    return { service, keySet: state?.keySet ?? false, enabled: state?.enabled ?? false }
  })
}

export function searchSave(input: Parameters<typeof SearchSave.parse>[0]): void {
  const value = SearchSave.parse(input)
  saveBackend({ id: value.service, key: value.key, enabled: value.enabled })
  discoverChanged()
}

export function hasSearch(): boolean {
  return hasWebBackend()
}

export async function search(
  query: string,
  options: {
    count?: number
    freshness?: 'day' | 'week' | 'month' | 'year'
    service?: SearchService
    signal?: AbortSignal
    guard?: () => void
  } = {}
): Promise<SearchResult[]> {
  // 无配置也交给网关检查用途与隐私，不能用兼容层的空结果绕过新守卫。
  const { results } = await searchWeb(query, {
    count: Math.min(10, Math.max(1, options.count ?? 8)),
    freshness: options.freshness,
    signal: options.signal,
    guard: options.guard,
    legacyService: options.service
  })
  return results.map(({ url, title, snippet, publishedAt }) => ({
    url,
    title,
    snippet,
    ...(publishedAt === undefined ? {} : { publishedAt })
  }))
}

export async function searchTest(service: SearchService): Promise<{ ok: boolean; message: string }> {
  let ok = false
  try {
    ok = (await testBackend(service)).ok
  } catch {
    // 保持旧 IPC 的诊断文案，不把内部错误或服务返回内容带到界面。
  }
  return {
    ok,
    message: ok
      ? tr('搜索连接成功', 'Search connection succeeded')
      : tr('搜索连接失败，请检查 Key 与网络', 'Search connection failed; check key and network')
  }
}
