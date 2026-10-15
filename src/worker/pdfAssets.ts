import { readFile } from 'fs/promises'
import { join } from 'path'

type AssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'
/** utilityProcess 没有 document/fetch 文件能力，明确用本地 I/O 读取随包的 PDF 资源。 */
export class PdfBinaryDataFactory {
  constructor(private readonly roots: Partial<Record<AssetKind, string>>) {}
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (
      !['cMapUrl', 'standardFontDataUrl', 'wasmUrl'].includes(kind) ||
      !/^[\w.-]+$/.test(filename) ||
      filename === '..' ||
      filename === '.'
    )
      throw new Error('无效的 PDF 资源名')
    const root = this.roots[kind as AssetKind]
    if (!root) throw new Error('缺少 PDF 资源目录')
    return new Uint8Array(await readFile(join(root, filename)))
  }
}
