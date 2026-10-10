import type { SourceKind } from '@shared/types'

// 中国传统粉彩：竹青、天青、藕荷、杏、樱、鹅黄、月白
export const TINTS = ['bamboo', 'sky', 'lotus', 'apricot', 'sakura', 'gosling', 'moon'] as const
export type Tint = (typeof TINTS)[number]

/** 未指定颜色时，按 ID 稳定地分配一种粉彩 */
export function tintFor(id: string, color?: string | null): Tint {
  if (color && (TINTS as readonly string[]).includes(color)) return color as Tint
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return TINTS[h % TINTS.length]
}

/** 资料类型的固定配色 */
export const KIND_TINT: Record<SourceKind, Tint> = {
  book: 'apricot',
  pdf: 'sakura',
  video: 'lotus',
  audio: 'sky',
  recording: 'sky',
  image: 'gosling',
  document: 'moon',
  web: 'bamboo',
  other: 'moon'
}
