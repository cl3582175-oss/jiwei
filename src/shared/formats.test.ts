import { expect, it } from 'vitest'
import { FORMATS, CURRENT_PARSE_VERSION } from './formats'
import { CODE_EXTS } from './attachments'
it('统一格式表保留既有格式、代码和识别路径，并开放doc解析', () => {
  expect(CURRENT_PARSE_VERSION).toBe(2)
  expect(FORMATS.doc).toMatchObject({ kind: 'document', parser: 'parseDoc' })
  expect(FORMATS.docx.parser).toBe('parseDocx')
  expect(FORMATS.xlsx.parser).toBe('parseXlsx')
  expect(FORMATS.pptx.parser).toBe('parsePptx')
  for (const ext of CODE_EXTS) expect(FORMATS[ext]).toMatchObject({ kind: 'document', parser: 'parseCode' })
  expect(FORMATS.png).toMatchObject({ kind: 'image', parser: null })
  expect(FORMATS.mp4).toMatchObject({ kind: 'video', parser: null })
  for (const ext of ['xls', 'ppt'])
    expect(FORMATS[ext]).toMatchObject({
      parser: null,
      note: {
        zh: '暂时读不了旧版 .xls / .ppt 的内容。在 Excel / PowerPoint 里另存为 .xlsx / .pptx 后重新导入即可。',
        en: "Legacy .xls / .ppt content can't be read yet. Save it as .xlsx / .pptx and import again."
      }
    })
})
