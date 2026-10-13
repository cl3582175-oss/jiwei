import type { DocNode } from '@shared/types'
import { nodeText } from './derive'

/** 只接受素材协议，不把任意网址/路径作为笔记图片资产读取。 */
export function imageAssetId(node: DocNode): string | null {
  if (node.type !== 'image' || typeof node.attrs?.src !== 'string') return null
  return /^jiwei:\/\/asset\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/i.exec(node.attrs.src)?.[1].toLowerCase() ?? null
}

export function imagesIn(node: DocNode): DocNode[] {
  return node.type === 'image' ? [node] : (node.content ?? []).flatMap(imagesIn)
}

export function noteContentText(node: DocNode, zh: boolean, lookup: (assetId: string) => string | null = () => null): string {
  const images = imagesIn(node).map((image) => {
    const assetId = imageAssetId(image)
    const text = assetId ? lookup(assetId)?.trim().slice(0, 1500) : null
    return `${zh ? '[图片' : '[Image'} ${image.attrs?.id ?? '?'}] ${image.attrs?.alt ?? ''}\n${text || (zh ? '（图片尚未识别文字）' : '(Image text has not been recognized yet)')}`
  })
  return [nodeText(node).trim(), ...images].filter(Boolean).join('\n')
}
