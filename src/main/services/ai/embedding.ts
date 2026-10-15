import { net } from 'electron'
import log from 'electron-log/main'
import { EMBEDDING_DIM, LOCAL_EMBEDDING } from '@shared/ai'
import type { EmbeddingStatus } from '@shared/types'
import { getSettings } from '../settings'
import { emit } from '../../events'
import { decryptKey, getProviderRow } from './providers'
import * as local from './localEmbedding'
import { EmbeddingDimensionError } from '../../lib/embeddingDimension'
export { EmbeddingDimensionError } from '../../lib/embeddingDimension'

// 向量服务门面：本地 EmbeddingGemma 2 或云端 OpenAI 兼容 /embeddings 接口。
// 输出统一为 512 维单位向量（本地模型 MRL 截断后再归一化；云端请求 dimensions=512）。

let status: EmbeddingStatus = {
  mode: 'local',
  state: 'missing',
  progress: 0,
  mirror: null,
  speed: null,
  message: null,
  indexed: 0,
  total: 0
}
let installing: Promise<void> | null = null
let errorModel: string | null = null

export function getStatus(): EmbeddingStatus {
  return status
}

export function setStatus(patch: Partial<EmbeddingStatus>, forModel?: string): void {
  if (patch.state === 'error') errorModel = forModel ?? currentModelId()
  else if (patch.state) errorModel = null
  status = { ...status, ...patch }
  if (patch.state === 'error') status.mode = errorModel?.startsWith('cloud:') ? 'cloud' : 'local'
  emit('embedding:status', status)
}

/** 当前向量模型标识：切换后需要重建索引 */
export function currentModelId(): string {
  const e = getSettings().ai.embedding
  return e.mode === 'local' ? LOCAL_EMBEDDING.id : `cloud:${e.providerId}:${e.model}`
}

function normalize(v: number[]): number[] {
  const t = v.slice(0, EMBEDDING_DIM)
  const n = Math.sqrt(t.reduce((s, x) => s + x * x, 0)) || 1
  return t.map((x) => x / n)
}

/** 刷新状态（启动时 / 设置变化后） */
export async function refreshStatus(resetError = false): Promise<EmbeddingStatus> {
  const e = getSettings().ai.embedding
  // 同一配置的维度/加载错误不能因界面轮询被抹去；更换模型或明确重试才复位。
  if (!resetError && status.state === 'error' && errorModel === currentModelId()) return status
  if (e.mode === 'cloud') {
    setStatus({ mode: 'cloud', state: e.providerId && e.model ? 'ready' : 'unconfigured', message: null, progress: 0 })
  } else if (!installing) {
    setStatus({ mode: 'local', state: (await local.isInstalled()) ? 'ready' : 'missing', progress: 0, message: null })
  }
  return status
}

/** 下载并启动本地模型（多镜像测速、断点续传、校验） */
export function installLocal(): Promise<void> {
  if (installing) return installing
  setStatus({ mode: 'local', state: 'downloading', progress: 0, message: null })
  installing = local
    .install((p) => {
      // 运行时约占 4%，模型约占 96%
      const frac = p.received / p.total
      setStatus({ progress: p.stage === 'runtime' ? frac * 0.04 : 0.04 + frac * 0.96, mirror: p.mirror, speed: p.speed })
    })
    .then(async () => {
      setStatus({ state: 'starting', progress: 1, speed: null })
      await local.start()
      setStatus({ state: 'ready', mirror: null })
    })
    .catch((e: unknown) => {
      log.error('[embedding] install failed', e)
      setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) }, LOCAL_EMBEDDING.id)
      throw e
    })
    .finally(() => {
      installing = null
    })
  return installing
}

async function embedCloud(inputs: string[]): Promise<number[][]> {
  const e = getSettings().ai.embedding
  if (!e.providerId || !e.model) throw new Error('未配置云端向量模型')
  const row = getProviderRow(e.providerId)
  const key = decryptKey(row)
  const res = await net.fetch(`${row.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: e.model, input: inputs, dimensions: EMBEDDING_DIM, encoding_format: 'float' })
  })
  if (!res.ok) throw new Error(`向量服务出错：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { data: { index: number; embedding: number[] }[] }
  for (const item of body.data) if (item.embedding.length !== EMBEDDING_DIM) throw new EmbeddingDimensionError(item.embedding.length)
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

/** 是否可以计算向量（本地已安装或云端已配置） */
export async function isReady(): Promise<boolean> {
  const e = getSettings().ai.embedding
  if (e.mode === 'cloud') return !!(e.providerId && e.model)
  return local.isInstalled()
}

const BATCH = 16

/**
 * 计算向量。kind = query 用于检索问题，doc 用于知识库内容（EmbeddingGemma 要求不同的提示前缀）。
 */
export async function embed(texts: string[], kind: 'query' | 'doc', titles?: string[], beforeSend?: () => void): Promise<number[][]> {
  const e = getSettings().ai.embedding
  const inputs =
    e.mode === 'local'
      ? texts.map((t, i) => (kind === 'query' ? LOCAL_EMBEDDING.queryPrefix + t : LOCAL_EMBEDDING.docPrefix(titles?.[i] ?? '') + t))
      : texts
  const out: number[][] = []
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH)
    // 网页权限可能在上一批等待期间改变；每批发送前及完成后重查，旧调用不传守卫。
    beforeSend?.()
    const vecs = e.mode === 'local' ? await local.embedRaw(batch) : await embedCloud(batch)
    beforeSend?.()
    out.push(...vecs.map(normalize))
  }
  return out
}

export function shutdown(): void {
  local.stop()
}
