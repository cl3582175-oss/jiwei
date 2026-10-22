// 内置浏览器的隐私规则（v0.6.0）：哪些页面自动关闭 AI（不提取正文、不显示浮条、不存为资料）。
// 用户的“不发送给 AI 的网站”按域名后缀匹配；另有内置的敏感类别：网银、支付、邮箱、登录与账户页。

const BUILTIN_HOSTS = [
  // 银行
  'icbc.com.cn',
  'ccb.com',
  'boc.cn',
  'abchina.com',
  'bankcomm.com',
  'cmbchina.com',
  'psbc.com',
  'spdb.com.cn',
  'cib.com.cn',
  'citicbank.com',
  'cebbank.com',
  'hxb.com.cn',
  'pingan.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'hsbc.com',
  'citi.com',
  // 支付
  'alipay.com',
  'paypal.com',
  'pay.weixin.qq.com',
  'pay.qq.com',
  'unionpay.com',
  '95516.com',
  'stripe.com',
  // 邮箱
  'mail.qq.com',
  'exmail.qq.com',
  'mail.163.com',
  'mail.126.com',
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.yahoo.com',
  'mail.sina.com.cn',
  // 账户与登录
  'accounts.google.com',
  'myaccount.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'passport.baidu.com',
  'passport.bilibili.com',
  'account.bilibili.com'
]
const BUILTIN_HOST_PATTERNS = [/(^|\.)(e?bank|netbank|ibank)\./i, /(^|\.)(passport|login|signin|sso|auth)\./i, /(^|\.)(mail|webmail)\./i]

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

const matches = (host: string, domain: string): boolean => {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, '')
  return !!d && (host === d || host.endsWith(`.${d}`))
}

/** 敏感页面：内置类别或用户列表中的网站 */
export function isSensitiveUrl(url: string, blocked: string[] = []): boolean {
  const host = hostOf(url)
  if (!host) return false
  if (blocked.some((d) => matches(host, d))) return true
  if (BUILTIN_HOSTS.some((d) => matches(host, d))) return true
  return BUILTIN_HOST_PATTERNS.some((re) => re.test(host))
}

export { canonicalUrl } from '@shared/browserUrl'
