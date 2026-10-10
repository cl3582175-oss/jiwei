import { tr } from '../../lib/messages'
import { session } from 'electron'
import { getSettings, setSettings } from '../settings'
import { generatePac, NetworkRuleSchema, type NetworkRule } from '@shared/browserSafety'
import { z } from 'zod'

let systemProxy = 'DIRECT'
let serial = Promise.resolve()
let appliedConfig: string | null = null
export async function networkStatus(): Promise<{ proxyAvailable: boolean; rules: NetworkRule[] }> {
  const task = serial.then(refreshBrowserNetwork)
  serial = task.catch(() => {})
  await task
  return { proxyAvailable: systemProxy !== 'DIRECT', rules: getSettings().browser?.networkRules ?? [] }
}
export async function refreshBrowserNetwork(): Promise<void> {
  const probe = session.fromPartition('jiwei-system-proxy')
  await probe.setProxy({ mode: 'system' })
  systemProxy = await probe.resolveProxy('https://en.wikipedia.org/')
  const rules = getSettings().browser?.networkRules ?? [],
    ses = session.fromPartition('persist:jiwei-browser')
  const config = JSON.stringify({ systemProxy, rules })
  // 状态查询可能因窗口重新获焦而重复执行。仅在配置改变时关闭连接，
  // 避免读取状态本身中断正在加载的真实网页和视频。
  if (config === appliedConfig) return
  if (!rules.length) await ses.setProxy({ mode: 'system' })
  else
    await ses.setProxy({
      pacScript: 'data:application/x-ns-proxy-autoconfig;base64,' + Buffer.from(generatePac(rules, systemProxy)).toString('base64')
    })
  await ses.closeAllConnections()
  appliedConfig = config
}
export function setNetworkRules(rules: NetworkRule[]): Promise<void> {
  const parsed = z.array(NetworkRuleSchema).max(500).parse(rules)
  const task = serial.then(async () => {
    const probe = session.fromPartition('jiwei-system-proxy')
    await probe.setProxy({ mode: 'system' })
    systemProxy = await probe.resolveProxy('https://en.wikipedia.org/')
    if (systemProxy === 'DIRECT' && parsed.some((r) => r.mode === 'proxy')) throw new Error(tr('未读到系统代理地址，请先开启系统代理', 'No system proxy found. Turn on the system proxy first.'))
    const unique = [...new Map(parsed.map((r) => [r.domain, r])).values()],
      before = getSettings().browser
    setSettings({ browser: { ...before, networkRules: unique } })
    try {
      await refreshBrowserNetwork()
    } catch (error) {
      setSettings({ browser: before ?? {} })
      throw error
    }
  })
  serial = task.catch(() => {})
  return task
}
