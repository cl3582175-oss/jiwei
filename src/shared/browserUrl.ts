/** 资料保存与时间点回跳使用相同的网址身份，分 P 必须区分，播放位置不另建资料。 */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|spm$|from$|share_|fbclid$|gclid$)/i.test(k)) u.searchParams.delete(k)
    if (/(^|\.)(bilibili\.com|youtube\.com|youtu\.be)$/.test(u.hostname)) {
      u.searchParams.delete('t')
      u.searchParams.delete('start')
    }
    return u.toString()
  } catch {
    return url
  }
}
