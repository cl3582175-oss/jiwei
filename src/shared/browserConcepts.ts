import { z } from 'zod'
import { findConceptMatches } from './conceptMatch'

const PageUrl = z
  .string()
  .min(1)
  .max(8192)
  .url()
  .refine((url) => /^https?:\/\//i.test(url))
export const ConceptPageSchema = z.object({ url: PageUrl }).strict()
export const ConceptDescribeSchema = z.object({ url: PageUrl, name: z.string().trim().min(1).max(40) }).strict()

/** 只返回笔记原文，悬停不调用模型；从命中处附近截取，避免长笔记的开头挤掉解释。 */
export function conceptExcerpt(text: string, name: string): string | null {
  const match = findConceptMatches(text, [name], 1)[0]
  if (!match) return null
  const lineStart = text.lastIndexOf('\n', match.start) + 1
  const start = Math.max(lineStart, match.start - 60)
  return text.slice(start, start + 200).trim()
}
