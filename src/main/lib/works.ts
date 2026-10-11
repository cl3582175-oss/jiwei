// 创作工坊的纯文本处理（v0.9）：主进程服务与单测共用，不依赖 Electron。

/** 要点、标题里的素材编号（出处已单独记录）去掉，界面上不出现“（M6）” */
export const noRefs = (s: string): string => s.replace(/\s*[（([]\s*M\d{1,2}(?:\s*[、,，]\s*M\d{1,2})*\s*[）)\]]/g, '').trim()

/** 正文开头若重复了本节标题（含 Markdown 标题行），去掉 */
export function stripLeadingTitle(body: string, title: string): string {
  const lines = body.trim().split('\n')
  const first =
    lines[0]
      ?.replace(/^#+\s*/, '')
      .replace(/\*\*/g, '')
      .trim() ?? ''
  const norm = (s: string): string => s.replace(/[\s#*：:、，,。.“”"'‘’]/g, '')
  if (/^#{1,6}\s/.test(lines[0] ?? '') || (first && norm(first) === norm(title))) return lines.slice(1).join('\n').trim()
  return body.trim()
}
