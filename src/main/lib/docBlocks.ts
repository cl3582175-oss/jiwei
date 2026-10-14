export type DocBlock =
  | { type: 'heading'; level: number; text: string; page?: number }
  | { type: 'paragraph'; text: string; page?: number }
  | { type: 'table'; caption?: string; header: string[] | null; rows: string[][]; html?: string; page?: number }
  | { type: 'code'; text: string; page?: number }

/** 单行的默认层级；编/部分引起的文档级下移由切分器处理，避免共享可变状态。 */
export function headingLevel(line: string): number | null {
  const text = line.trim()
  if (!text || [...text].length > 60 || /[。.;；]$/.test(text) || /[:：]\s*\S/.test(text)) return null
  if (/(?:[.．·─]{4,}|…+)\s*\d+\s*$/.test(text)) return null
  const chapter = text.match(/^第[〇零一二两三四五六七八九十百千\d]+(编|部分|章|节|条)/)
  if (chapter) return ({ 编: 1, 部分: 1, 章: 1, 节: 2, 条: 3 } as Record<string, number>)[chapter[1]]
  if (/^[一二三四五六七八九十百]+、\s*\S/.test(text)) return 1
  if (/^[（(][一二三四五六七八九十百]+[）)]\s*\S/.test(text)) return 2
  if (/^(?:附件|附录)[A-Za-z〇零一二三四五六七八九十\d]+/.test(text)) return 1
  const numbered = text.match(/^(\d+(?:[.．]\d+){1,3})(?=\s|\p{Letter}|$)/u)
  if (numbered) return numbered[1].split(/[.．]/).length
  if ([...text].length <= 30 && /^\d+(?:[.．、]\s*|\s+)\p{Script=Han}/u.test(text)) return 1
  if (/^Chapter\s+\d+\b/i.test(text) || /^\d+(?:\.\s*|\s+)[A-Z]/.test(text)) return 1
  return null
}
