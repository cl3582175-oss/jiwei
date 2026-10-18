import { currentRun } from '../../agent/context'
import { getSettings } from '../../settings'
import { onMainEvent } from '../../../events'
import { tr } from '../../../lib/messages'
import { privacyFingerprint } from '../../ai/privacy'
import { credentialsFor } from '../backends/store'
import { jsonResponse, request } from '../backends/common'
import { assertReadableUrl } from '../pagePolicy'
import { webPolicyOf } from '../policy'
import { DailyLimitError, recordCall, reserveCall } from '../calls'

export class CloudReadError extends Error {
  constructor(readonly reason: 'configuration' | 'restricted' | 'revoked' | 'failed' | 'empty' | 'canceled' | 'timeout') {
    const words = {
      configuration: [
        '请先开启手动云端代读并配置 DeepSeek 官方凭证',
        'Enable manual cloud reading and configure official DeepSeek credentials first'
      ],
      restricted: ['这个网址不适合发送到云端读取', 'This address cannot be sent for cloud reading'],
      revoked: ['读取权限或凭证已变化，已停止使用云端结果', 'Reading permission or credentials changed; cloud results were discarded'],
      failed: [
        'DeepSeek 云端读取失败，请稍后再试或检查凭证及余额',
        'DeepSeek cloud reading failed; try later or check credentials and balance'
      ],
      empty: ['云端未获得可读正文', 'Cloud reading returned no usable text'],
      canceled: ['读取已取消', 'Reading canceled'],
      timeout: ['云端读取超时', 'Cloud reading timed out']
    } as const
    super(tr(words[reason][0], words[reason][1]))
    this.name = 'CloudReadError'
  }
}

/** Checks known input only. It cannot inspect the provider's internal redirects. */
export function assertCloudUrl(value: string): void {
  assertReadableUrl(value)
  const url = new URL(value)
  const credential = /(?:token|secret|password|passwd|api.?key|signature|credential|authorization|access.?key|auth|session|ticket|jwt|sig)/i
  if (
    [...url.searchParams.keys()].some((key) => credential.test(key)) ||
    /\/(?:login|signin|sign-in|oauth|sso|authorize)(?:\/|$)/i.test(url.pathname)
  )
    throw new CloudReadError('restricted')
}

let active = 0
const starts: number[] = []
async function acquire(signal: AbortSignal): Promise<() => void> {
  while (true) {
    signal.throwIfAborted()
    const now = performance.now()
    while (starts.length && starts[0] <= now - 1000) starts.shift()
    if (active < 2 && starts.length < 5) {
      active++
      starts.push(now)
      return () => {
        active--
      }
    }
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const timer = setTimeout(done, 50)
      const abort = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        reject(new CloudReadError('canceled'))
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

export async function readDeepSeekPage(
  url: string,
  opts: { signal?: AbortSignal; guard?: () => void }
): Promise<{ title: string; text: string; truncated: boolean }> {
  const originalKey = credentialsFor('deepseek').key
  const fingerprint = privacyFingerprint()
  const validate = (): void => {
    opts.signal?.throwIfAborted()
    if (webPolicyOf(currentRun()?.purpose) !== 'tool' || !getSettings().retrieval.cloudReader || !originalKey?.trim())
      throw new CloudReadError('configuration')
    if (credentialsFor('deepseek').key !== originalKey || privacyFingerprint() !== fingerprint) throw new CloudReadError('revoked')
    assertCloudUrl(url)
    opts.guard?.()
  }
  validate()
  const revoked = new AbortController()
  const stop = (['retrieval:changed', 'settings:changed', 'notes:changed', 'sources:changed'] as const).map((event) =>
    onMainEvent(event, () => {
      try {
        validate()
      } catch {
        revoked.abort()
      }
    })
  )
  const timeout = AbortSignal.timeout(15000)
  const signal = AbortSignal.any([timeout, revoked.signal, ...(opts.signal ? [opts.signal] : [])])
  let release: (() => void) | undefined
  let releaseCall: (() => void) | undefined
  const start = Date.now()
  let ok = false
  try {
    release = await acquire(signal)
    validate()
    releaseCall = reserveCall()
    const response = await request('deepseek', 'https://api.deepseek.com/v1/tools/fetch', signal, {
      fixtureSuffix: '/fetch',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + originalKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    })
    signal.throwIfAborted()
    validate()
    const data = jsonResponse(response)
    if (typeof data.title !== 'string' || typeof data.content !== 'string') throw new CloudReadError('failed')
    const text = data.content.replace(/\r\n?/g, '\n')
    if (!text.trim()) throw new CloudReadError('empty')
    ok = true
    return { title: data.title.slice(0, 500), text: text.slice(0, 60000), truncated: text.length > 60000 }
  } catch (error) {
    if (opts.signal?.aborted) throw new CloudReadError('canceled')
    if (revoked.signal.aborted) throw new CloudReadError('revoked')
    if (timeout.aborted) throw new CloudReadError('timeout')
    if (error instanceof CloudReadError || error instanceof DailyLimitError) throw error
    throw new CloudReadError('failed')
  } finally {
    release?.()
    for (const unsubscribe of stop) unsubscribe()
    if (releaseCall) {
      try {
        recordCall('deepseek-fetch', 'fetch', ok, false, start)
      } finally {
        releaseCall()
      }
    }
  }
}
