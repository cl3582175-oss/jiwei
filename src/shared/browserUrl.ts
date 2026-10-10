/** 资料保存与时间点回跳使用相同的网址身份，分 P 必须区分，播放位置不另建资料。 */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    for (const k of [...u.searchParams.keys()])
      if (/^(utm_|spm$|spm_id_from$|from$|from_spmid$|share_|fbclid$|gclid$|vd_source$|si$)/i.test(k)) u.searchParams.delete(k)
    // 视频站只保留决定“是哪个视频”的参数：登录后网站会在加载完成后再追加跟踪参数（如 B 站的 vd_source），
    // 不能因此把同一个视频当成另一个网址。
    const keep = /(^|\.)bilibili\.com$/.test(u.hostname) ? ['p'] : /(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname) ? ['v', 'list', 'index'] : null
    if (keep) for (const k of [...u.searchParams.keys()]) if (!keep.includes(k)) u.searchParams.delete(k)
    return u.toString()
  } catch {
    return url
  }
}
