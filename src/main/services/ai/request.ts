import { streamText, wrapLanguageModel, type LanguageModelUsage, type ModelMessage } from 'ai'
import log from 'electron-log/main'
import { currentRun, withPurpose } from '../agent/context'
import { getSettings } from '../settings'
import { notePrivacyEn, notePrivacyZh } from '../../../renderer/src/features/notes/notePrivacyMessages'
import type { Effort } from '@shared/ai'
import { buildModel } from './model'
import { getProviderRow, learnOutputLimit } from './providers'

export class ModelIdleTimeout extends Error {
  readonly temporary = true
  constructor(
    readonly ms: number,
    readonly hard = false
  ) {
    const zh = getSettings().language.startsWith('zh')
    super(
      hard
        ? zh
          ? `模型请求超过 ${ms / 1000} 秒的执行上限，已中断。`
          : `The model request exceeded its ${ms / 1000} second hard limit and was stopped.`
        : (zh ? notePrivacyZh : notePrivacyEn).aiIdleTimeout.replace('{sec}', String(ms / 1000))
    )
    this.name = 'ModelIdleTimeout'
  }
}

export class ModelOutputTruncated extends Error {
  readonly temporary = true
  constructor(readonly usage: LanguageModelUsage) {
    const pct = Math.min(100, Math.round(((usage.outputTokenDetails.reasoningTokens ?? 0) / Math.max(1, usage.outputTokens ?? 0)) * 100))
    super((getSettings().language.startsWith('zh') ? notePrivacyZh : notePrivacyEn).aiOutputTruncated.replace('{pct}', String(pct)))
    this.name = 'ModelOutputTruncated'
  }
}

export interface RequestDiagnostics {
  purpose?: string
  model?: string
  phase?: 'tool' | 'json' | 'text'
  /** 未知来源按敏感处理；只有调用方能确认公开时才允许输出正文预览。 */
  sensitive?: boolean
}
export interface ModelRequestOptions {
  providerId: string
  model: string
  system: string
  prompt: string
  effort?: Effort
  images?: { data: Uint8Array; mediaType: string }[]
  onUsage?: (usage: LanguageModelUsage) => void
  signal?: AbortSignal
  guard?: () => void
  purpose?: string
  maxOutputTokens?: number
  sensitive?: boolean
}
type RequestResult = {
  text: string
  toolCalls: Awaited<ReturnType<typeof streamText>['toolCalls']>
  finishReason: string
  usage: LanguageModelUsage
}
type RequestArgs = Parameters<typeof streamText>[0] & {
  idleMs?: number
  hardMs?: number
  diagnostics?: RequestDiagnostics
}

export function logModelFailure(label: string, diagnostics: RequestDiagnostics, result?: Partial<RequestResult>): void {
  const text = result?.text ?? ''
  log.warn(
    `[${label}] ${JSON.stringify({
      purpose: diagnostics.purpose ?? currentRun()?.purpose ?? 'model',
      model: diagnostics.model ?? 'unknown',
      phase: diagnostics.phase ?? 'text',
      finishReason: result?.finishReason ?? 'unknown',
      outputTokens: result?.usage?.outputTokens ?? 0,
      reasoningTokens: result?.usage?.outputTokenDetails.reasoningTokens ?? 0,
      textLength: text.length,
      ...(diagnostics.sensitive === false ? { preview: text.slice(0, 120) } : {})
    })}`
  )
}

/** 每个物理请求独立计时：首片 120 秒，之后空闲 60 秒，硬上限 15 分钟。 */
export async function generateWithIdle(args: RequestArgs): Promise<RequestResult> {
  const run = () => generate(args)
  return args.diagnostics?.purpose ? withPurpose(args.diagnostics.purpose, run) : run()
}

async function generate(args: RequestArgs): Promise<RequestResult> {
  const { idleMs = 60_000, hardMs = 900_000, diagnostics = {}, ...request } = args
  const controller = new AbortController()
  const signal = request.abortSignal ? AbortSignal.any([request.abortSignal, controller.signal]) : controller.signal
  let idle: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number): void => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(new ModelIdleTimeout(ms)), ms)
  }
  const hard = setTimeout(() => controller.abort(new ModelIdleTimeout(hardMs, true)), hardMs)
  arm(120_000)
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = (): void => {
    rejectAbort!(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let text = '',
    finishReason = 'unknown',
    usage: LanguageModelUsage | undefined
  let providerText = '',
    providerFinish = 'unknown',
    providerUsage: LanguageModelUsage | undefined
  try {
    signal.throwIfAborted()
    // 在 SDK 强制工具校验之前观察真实流：它可能把 length+无工具转成校验错误，
    // 也可能缓冲工具参数；两者都不能遮住活跃输出与服务商用量。
    const model =
      typeof request.model === 'string'
        ? request.model
        : wrapLanguageModel({
            model: request.model as never,
            middleware: {
              wrapStream: async ({ doStream }) => {
                const response = await doStream()
                return {
                  ...response,
                  stream: response.stream.pipeThrough(
                    new TransformStream({
                      transform(part, c) {
                        signal.throwIfAborted()
                        arm(idleMs)
                        if (part.type === 'text-delta') providerText += part.delta
                        if (part.type === 'finish') {
                          providerFinish = part.finishReason.unified
                          const u = part.usage
                          providerUsage = {
                            inputTokens: u.inputTokens.total,
                            inputTokenDetails: {
                              noCacheTokens: u.inputTokens.noCache,
                              cacheReadTokens: u.inputTokens.cacheRead,
                              cacheWriteTokens: u.inputTokens.cacheWrite
                            },
                            outputTokens: u.outputTokens.total,
                            outputTokenDetails: { textTokens: u.outputTokens.text, reasoningTokens: u.outputTokens.reasoning },
                            totalTokens: (u.inputTokens.total ?? 0) + (u.outputTokens.total ?? 0),
                            raw: u.raw
                          }
                        }
                        c.enqueue(part)
                      }
                    })
                  )
                }
              }
            }
          })
    const result = streamText({
      ...request,
      model,
      // 与 generateText 默认一致：429/5xx 在开始输出前由 SDK 重试，不能让其他 30 多个调用方失去重试。
      maxRetries: request.maxRetries ?? 2,
      includeRawChunks: true,
      abortSignal: signal,
      onError: request.onError ?? (() => {})
    })
    const consume = async (): Promise<RequestResult> => {
      let failure: unknown
      for await (const part of result.fullStream) {
        signal.throwIfAborted()
        // start/start-step 是 SDK 自己的事件，不能用它们提前耗掉首片宽限。
        if (!['start', 'start-step', 'finish', 'finish-step', 'abort', 'error'].includes(part.type)) arm(idleMs)
        if (part.type === 'text-delta') text += part.text
        if (part.type === 'error') failure = part.error
        if (part.type === 'finish-step') {
          finishReason = part.finishReason
          usage = part.usage
        }
        if (part.type === 'finish') {
          finishReason = part.finishReason
          usage = part.totalUsage
        }
      }
      signal.throwIfAborted()
      if (providerFinish === 'length' && providerUsage)
        return { text: providerText, toolCalls: [], finishReason: providerFinish, usage: providerUsage }
      if (failure) throw failure
      const [body, toolCalls, reason, tokens] = await Promise.all([result.text, result.toolCalls, result.finishReason, result.usage])
      return { text: body, toolCalls, finishReason: reason, usage: tokens }
    }
    return await Promise.race([consume(), aborted])
  } catch (error) {
    logModelFailure(
      'generateWithIdle',
      { model: typeof request.model === 'string' ? request.model : request.model.modelId, ...diagnostics },
      {
        text: providerText || text,
        finishReason: providerFinish !== 'unknown' ? providerFinish : finishReason,
        usage: providerUsage ?? usage
      }
    )
    throw error
  } finally {
    clearTimeout(idle)
    clearTimeout(hard)
    signal.removeEventListener('abort', onAbort)
  }
}

/** 只把输出参数的 400 拒绝当作额度反馈，不把上下文超限误学成输出上限。 */
export function rejectedOutputLimit(error: unknown, requested: number): number | null {
  const e = error as { statusCode?: number; status?: number; message?: string; responseBody?: string }
  if ((e?.statusCode ?? e?.status) !== 400) return null
  const message = `${e.message ?? ''} ${e.responseBody ?? ''}`
  // 只认明确指向输出额度的拒绝；“maximum” 单独出现太宽（工具数、消息数等也会这么写）。
  if (!/max_tokens|max_output|max_completion_tokens|output tokens?|maximum.{0,40}tokens?\b/i.test(message)) return null
  if (/context(?:[_ ]length|[_ ]window|.{0,12}(?:length|limit))|input tokens.*exceed/i.test(message)) return null
  const patterns = [
    /between\s+\d+\s+and\s+([\d,]+)/i,
    /(?:at most|up to|no (?:more|greater) than|cannot exceed|must not exceed|less than or equal to)\s*([\d,]+)/i,
    /maximum(?:\s+(?:allowed|supported))?(?:\s+output)?(?:\s+tokens?)?(?:\s+(?:limit|value))?(?:\s+(?:is|of))?\s*[:=]?\s*([\d,]+)/i,
    /(?:max_tokens|max_output_tokens)\s*(?:limit)?\s*[:=]\s*([\d,]+)/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(message)
    const n = match ? Number(match[1].replaceAll(',', '')) : NaN
    if (Number.isSafeInteger(n) && n > 0 && n < requested) return n
  }
  return requested > 1 ? Math.max(1, Math.floor(requested / 2)) : null
}

/** 结构化与纯文本请求共用额度策略；一次流程的工具和 JSON 阶段共享学习结果。 */
export function createModelRequest(opts: ModelRequestOptions) {
  const built = buildModel({ providerId: opts.providerId, model: opts.model, effort: opts.effort ?? 'off' })
  const input = opts.images?.length
    ? {
        messages: [
          {
            role: 'user',
            content: [
              ...opts.images.map((i) => ({ type: 'image' as const, image: i.data, mediaType: i.mediaType })),
              { type: 'text', text: opts.prompt }
            ]
          }
        ] as ModelMessage[]
      }
    : { prompt: opts.prompt }
  const stored = JSON.parse(getProviderRow(opts.providerId).modelCaps) as Record<string, { learnedMaxOutput?: number }>
  const limit = stored[opts.model]?.learnedMaxOutput
  let learned = limit && Number.isSafeInteger(limit) && limit > 0 ? limit : Infinity
  let budget = Math.min(Math.max(opts.maxOutputTokens ?? 0, built.maxOutputTokens ?? 8192), learned)
  let lengthRetried = false
  const state: { last?: RequestResult } = {}
  const diagnostics = (phase: 'tool' | 'json' | 'text'): RequestDiagnostics => ({
    purpose: opts.purpose,
    model: opts.model,
    phase,
    sensitive: opts.sensitive ?? true
  })
  return {
    state,
    diagnostics,
    async generate(
      phase: 'tool' | 'json' | 'text',
      overrides: Pick<RequestArgs, 'system' | 'tools' | 'toolChoice'> = {}
    ): Promise<RequestResult> {
      state.last = undefined
      let pendingLimit: number | null = null
      let rejections = 0
      while (true) {
        opts.guard?.()
        try {
          const r = await generateWithIdle({
            model: built.model,
            providerOptions: built.providerOptions as never,
            abortSignal: opts.signal,
            maxOutputTokens: budget,
            system: opts.system,
            ...input,
            ...overrides,
            diagnostics: diagnostics(phase)
          })
          state.last = r
          opts.onUsage?.(r.usage)
          opts.guard?.()
          if (pendingLimit !== null) {
            learnOutputLimit(opts.providerId, opts.model, pendingLimit)
            learned = pendingLimit
            pendingLimit = null
          }
          if (r.finishReason !== 'length') return r
          if (lengthRetried) throw new ModelOutputTruncated(r.usage)
          lengthRetried = true
          budget = Math.min(budget * 2, 65536, learned)
        } catch (error) {
          if (opts.signal?.aborted) throw error
          const limit = rejectedOutputLimit(error, budget)
          // 最多降三次：服务商错误文本不规范时，宁可报错也不连发十几次请求。
          if (limit === null || ++rejections > 3) throw error
          budget = limit
          pendingLimit = limit
        }
      }
    }
  }
}
