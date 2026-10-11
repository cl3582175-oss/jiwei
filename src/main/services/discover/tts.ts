import { net } from 'electron'
import type { TtsEngine, TtsProvider } from '@shared/discover'
import { TTS_MODELS } from '@shared/discover'
import { decryptKey, getProviderRow, listProviders } from '../ai/providers'
import { tr } from '../../lib/messages'

// AI 语音合成（v0.8 审查后加入）：每日学习播客用服务商的 TTS 读出讲稿，代替机械的系统语音。
// 只请求服务商本身（用户已配置的 API Key），不经过第三方；音频存本机。
//   - 通义（DashScope）qwen3-tts-flash：中文音色自然，¥0.8 / 万字符（汉字计 2 字符）
//   - OpenAI gpt-4o-mini-tts：多语种，约 $0.015 / 分钟
// 两家都按“字符数”估算费用（见 MODEL_PRICES 中的 TTS 条目），记入用量看板。

const KIND_ENGINE: Partial<Record<string, TtsEngine>> = { qwen: 'qwen', openai: 'openai' }

/** 可用于语音合成的服务商：已配置 API Key 的通义、OpenAI */
export function ttsProviders(): TtsProvider[] {
  return listProviders()
    .filter((p) => KIND_ENGINE[p.kind] && p.hasKey)
    .map((p) => ({ providerId: p.id, name: p.name, engine: KIND_ENGINE[p.kind]! }))
}

/** 计费字符数：中文等宽字符计 2（通义的规则；OpenAI 按同一口径估算） */
export function ttsChars(text: string): number {
  let n = 0
  for (const ch of text) n += /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 2 : 1
  return n
}

async function fail(res: Response): Promise<never> {
  let detail = ''
  try {
    const body = (await res.json()) as { message?: string; error?: { message?: string } }
    detail = body.error?.message ?? body.message ?? ''
  } catch {
    /* 非 JSON */
  }
  if (res.status === 401 || res.status === 403)
    throw new Error(tr('语音合成的 API Key 无效或没有开通该模型', 'The API key is invalid or the TTS model is not enabled'))
  throw new Error(`TTS HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`)
}

/** 合成一段文字，返回音频数据与扩展名 */
export async function synthesize(
  providerId: string,
  voice: string,
  text: string,
  language: string,
  signal?: AbortSignal
): Promise<{ data: Buffer; ext: 'wav' | 'mp3'; model: string }> {
  const row = getProviderRow(providerId)
  const engine = KIND_ENGINE[row.kind]
  if (!engine) throw new Error(tr('这个服务商不支持语音合成', 'This provider does not support speech synthesis'))
  const key = decryptKey(row)
  if (!key) throw new Error(tr('请先在「AI 模型」里填写这个服务商的 API Key', 'Add an API key for this provider in AI models first'))
  const timeout = AbortSignal.timeout(90_000)
  const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
  if (engine === 'qwen') {
    // 兼容模式地址 …/compatible-mode/v1 → 原生接口 …/api/v1
    const root = row.baseUrl.replace(/\/+$/, '').replace(/\/compatible-mode\/v1$/, '/api/v1')
    const res = await net.fetch(`${root}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODELS.qwen,
        input: { text, voice, language_type: language.startsWith('zh') ? 'Chinese' : 'English' }
      }),
      signal: sig
    })
    if (!res.ok) await fail(res)
    const body = (await res.json()) as { output?: { audio?: { url?: string } } }
    const url = body.output?.audio?.url
    if (!url) throw new Error(tr('语音合成没有返回音频', 'Speech synthesis returned no audio'))
    const audio = await net.fetch(url, { signal: sig })
    if (!audio.ok) await fail(audio)
    return { data: Buffer.from(await audio.arrayBuffer()), ext: 'wav', model: TTS_MODELS.qwen }
  }
  const res = await net.fetch(`${row.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODELS.openai,
      input: text,
      voice,
      response_format: 'mp3',
      instructions: language.startsWith('zh')
        ? '用自然、亲切的中文播客语气朗读，语速适中，句间自然停顿。'
        : 'Read in a warm, natural podcast tone at a comfortable pace.'
    }),
    signal: sig
  })
  if (!res.ok) await fail(res)
  return { data: Buffer.from(await res.arrayBuffer()), ext: 'mp3', model: TTS_MODELS.openai }
}
