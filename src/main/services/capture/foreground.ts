import { z } from 'zod'
import type { InboxOrigin } from '@shared/inbox'
import { isSensitiveUrl } from '../../lib/browserPolicy'
export const detailPermission = (enabled: boolean, denied: boolean): boolean => enabled && !denied
// 只有应用身份不涉及网页详情；未证明隐私资格时一律只保留这一层。
export function parseForeground(raw: string): InboxOrigin {
  const app = raw.trim().split(/\r?\n/)[0]
  return app ? { app: app.slice(0, 200) } : {}
}
export const ForegroundAppSchema = z.object({ name: z.string().max(200), bundleId: z.string().max(200) })
export const BrowserIdentitySchema = z.object({
  privacy: z.literal('normal'),
  windowId: z.number().int().positive(),
  tabId: z.number().int().positive(),
  url: z.string().max(4096)
})
export type BrowserIdentity = z.infer<typeof BrowserIdentitySchema>
const DetailSchema = BrowserIdentitySchema.extend({ title: z.string().max(500) })
export function eligibleBrowser(bundleId: string): 'Google Chrome' | 'Microsoft Edge' | null {
  if (bundleId === 'com.google.Chrome') return 'Google Chrome'
  if (bundleId === 'com.microsoft.edgemac') return 'Microsoft Edge'
  return null
}
function safeUrl(raw: string, blocked: string[]): boolean {
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isSensitiveUrl(raw, blocked)) return false
    // 外部浏览器无法读取页面的密码框状态；账户路径与凭证参数额外保守排除。
    if (
      /\/(?:login|signin|sign-in|sign_in|account|accounts|settings|checkout|payment|payments|billing|password|reset-password|oauth|authorize|auth|sso)(?:\/|$)/i.test(
        url.pathname
      )
    )
      return false
    const sensitiveKey =
      /^(?:pass(?:word)?|token|secret|auth(?:orization)?|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session|code)$/i
    for (const key of [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()])
      if (sensitiveKey.test(key)) return false
    return true
  } catch {
    return false
  }
}
export async function collectBrowserOrigin(
  app: string,
  readIdentity: () => Promise<unknown>,
  readDetails: (identity: BrowserIdentity) => Promise<unknown>,
  blocked: string[] = []
): Promise<InboxOrigin> {
  const fallback = parseForeground(app)
  const first = BrowserIdentitySchema.safeParse(await readIdentity())
  if (!first.success || !safeUrl(first.data.url, blocked)) return fallback
  const last = DetailSchema.safeParse(await readDetails(first.data))
  if (
    !last.success ||
    last.data.windowId !== first.data.windowId ||
    last.data.tabId !== first.data.tabId ||
    last.data.url !== first.data.url ||
    !safeUrl(last.data.url, blocked)
  )
    return fallback
  return { ...fallback, windowTitle: last.data.title, url: new URL(last.data.url).href }
}

// 先检查正常窗口再读取网址；第二次请求仅在同一窗口/标签/网址仍正常时读取标题。
// 应用名来自固定白名单；外部网址和标识只经 argv 传递，不能插入脚本代码。
export function browserProbeScript(browser: 'Google Chrome' | 'Microsoft Edge', details = false): string {
  return `function run(argv) {
    var app = Application(${JSON.stringify(browser)}), w = app.windows[0];
    if (w.mode() !== 'normal') return JSON.stringify({privacy:'unknown'});
    var tab = w.activeTab, value = {privacy:'normal',windowId:w.id(),tabId:tab.id(),url:tab.url()};
    ${
      details
        ? `var expected = JSON.parse(argv[0]);
    if (value.windowId !== expected.windowId || value.tabId !== expected.tabId || value.url !== expected.url) return JSON.stringify({privacy:'unknown'});
    value.title = String(tab.title()).slice(0,500);`
        : ''
    }
    if (w.mode() !== 'normal' || app.windows[0].id() !== value.windowId || w.activeTab.id() !== value.tabId || tab.url() !== value.url) return JSON.stringify({privacy:'unknown'});
    return JSON.stringify(value);
  }`
}
