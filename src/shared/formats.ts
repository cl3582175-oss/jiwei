import type { SourceKind } from './types'
import { CODE_EXTS } from './attachments'

export interface FormatInfo {
  kind: SourceKind
  parser: string | null
  label: string
  note?: { zh: string; en: string }
}
export const CURRENT_PARSE_VERSION = 3
const legacy = {
  zh: '暂时读不了旧版 .xls / .ppt 的内容。在 Excel / PowerPoint 里另存为 .xlsx / .pptx 后重新导入即可。',
  en: "Legacy .xls / .ppt content can't be read yet. Save it as .xlsx / .pptx and import again."
}
const group = (exts: string[], kind: SourceKind, label: string, parser: string | null = null): Record<string, FormatInfo> =>
  Object.fromEntries(exts.map((ext) => [ext, { kind, label, parser }]))

export const FORMATS: Record<string, FormatInfo> = {
  ...group(['pdf'], 'pdf', 'PDF', 'parsePdf'),
  ...group(['epub'], 'book', 'EPUB', 'parseEpub'),
  ...group(['mobi', 'azw3'], 'book', '电子书'),
  ...group(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'], 'video', '视频'),
  ...group(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'], 'audio', '音频'),
  ...group(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif'], 'image', '图片'),
  ...group(['doc'], 'document', 'Word', 'parseDoc'),
  ...group(['docx'], 'document', 'Word', 'parseDocx'),
  ...group(['txt', 'md', 'markdown'], 'document', '文本', 'segmentTextFile'),
  ...group(['html', 'htm'], 'document', '网页', 'parseHtml'),
  ...group(['xlsx'], 'document', 'Excel', 'parseXlsx'),
  ...group(['csv'], 'document', 'CSV', 'parseCsv'),
  ...group(['pptx'], 'document', 'PowerPoint', 'parsePptx'),
  xls: { kind: 'document', parser: null, label: 'Excel', note: legacy },
  ppt: { kind: 'document', parser: null, label: 'PowerPoint', note: legacy },
  ...group(CODE_EXTS, 'document', '代码', 'parseCode')
}
