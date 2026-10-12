import { constants } from 'fs'
import { open } from 'fs/promises'
import { safePluginPath } from './sources'

/** 可选图标只读固定路径，以有界 PNG data DTO 交给 renderer，绝不授予文件 URL。 */
export async function pluginIcon(root: string): Promise<string | undefined> {
  try {
    const file = await open(await safePluginPath(root, 'jiwei/icon.png'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 100 * 1024 || stat.size < 33) return undefined
      const data = Buffer.alloc(stat.size)
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      if (
        bytesRead !== data.length ||
        data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(8) !== 13
      )
        return undefined
      const width = data.readUInt32BE(16),
        height = data.readUInt32BE(20)
      if (!width || !height || width > 256 || height > 256) return undefined
      return `data:image/png;base64,${data.toString('base64')}`
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}
