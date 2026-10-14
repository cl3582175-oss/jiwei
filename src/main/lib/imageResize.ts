import { nativeImage } from 'electron'

/** 笔记图片和附件复用同一压缩方式，避免大图进入存储与模型请求。 */
export function compressImage(bytes: Uint8Array): Buffer {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (image.isEmpty()) throw new Error('Unable to resize image')
  const { width, height } = image.getSize()
  return image.resize(width >= height ? { width: Math.min(width, 1600) } : { height: Math.min(height, 1600) }).toJPEG(85)
}
