import { createCanvas } from '@napi-rs/canvas'

// 生成文档识别测试用的 PDF（无外部依赖）：
//   第 1 页：只有一张图片（模拟扫描件，中文段落），没有文字层
//   第 2 页：有文字层的英文页，带表标题与画了格线的表格（文字层会把单元格拆散）

/** 把几行中文画成“扫描页”图片（JPEG） */
export function scanImage(lines: string[], w = 1240, h = 1754): Buffer {
  const c = createCanvas(w, h)
  const g = c.getContext('2d')
  g.fillStyle = '#fbfaf6'
  g.fillRect(0, 0, w, h)
  g.fillStyle = '#222'
  g.font = '40px "PingFang SC", "Hiragino Sans GB", "Heiti SC", "Noto Sans CJK SC", sans-serif'
  lines.forEach((l, i) => g.fillText(l, 120, 200 + i * 70))
  return c.toBuffer('image/jpeg', 85)
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export function makeScanPdf(scan: Buffer, table: { caption: string; rows: string[][] }): Buffer {
  const objs: Obj[] = []
  const add = (body: Obj): number => objs.push(body)
  const catalog = add('')
  const pagesObj = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  // 第 1 页：整页图片
  const img = add(imageObj(scan, 1240, 1754))
  const s1 = 'q 595 0 0 842 0 0 cm /Im0 Do Q'
  const c1 = add(`<< /Length ${s1.length} >>\nstream\n${s1}\nendstream`)
  const p1 = add(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${c1} 0 R >>`
  )
  // 第 2 页：正文 + 表格（格线 + 单元格文字）
  const ops: string[] = [
    `BT /F1 13 Tf 60 780 Td (${esc('Chapter 3. Ways to study')}) Tj ET`,
    `BT /F1 11 Tf 60 755 Td (${esc('The table below compares common study methods by how much they help long-term memory.')}) Tj ET`,
    `BT /F1 12 Tf 60 715 Td (${esc(table.caption)}) Tj ET`,
    '0.2 G 0.8 w'
  ]
  const colW = 160
  const rowH = 28
  const top = 700
  table.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const x = 60 + c * colW
      const y = top - (r + 1) * rowH
      ops.push(`${x} ${y} ${colW} ${rowH} re S`)
      ops.push(`BT /F1 ${r === 0 ? 11.5 : 11} Tf ${x + 8} ${y + 9} Td (${esc(cell)}) Tj ET`)
    })
  )
  const s2 = ops.join('\n')
  const c2 = add(`<< /Length ${s2.length} >>\nstream\n${s2}\nendstream`)
  const p2 = add(
    `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c2} 0 R >>`
  )
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${p1} 0 R ${p2} 0 R] /Count 2 >>`

  return serialize(objs, catalog)
}

type Obj = string | Buffer[]

function serialize(objs: Obj[], catalog: number): Buffer {
  const parts: Buffer[] = []
  let len = 0
  const push = (b: string | Buffer): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b
    parts.push(buf)
    len += buf.length
  }
  push('%PDF-1.4\n')
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(len)
    push(`${i + 1} 0 obj\n`)
    if (typeof body === 'string') push(body)
    else body.forEach(push)
    push('\nendobj\n')
  })
  const xref = len
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`)
  push(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(parts)
}

const imageObj = (jpeg: Buffer, w: number, h: number): Buffer[] => [
  Buffer.from(
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    'latin1'
  ),
  jpeg,
  Buffer.from('\nendstream', 'latin1')
]

/** 自造 1 bit 图像蒙版，保留与黑白扫描 PDF 相同的绘制分支；不包含用户资料。 */
export function makeMaskPdf(): Buffer {
  const data = Buffer.alloc(128)
  for (let row = 0; row < 32; row++) data.fill(row % 4 < 2 ? 0x55 : 0xaa, row * 4, row * 4 + 4)
  const content = 'q 595 0 0 842 0 0 cm /Scan Do Q'
  return serialize(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>',
      [
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ImageMask true /BitsPerComponent 1 /Length ${data.length} >>\nstream\n`
        ),
        data,
        Buffer.from('\nendstream')
      ],
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
    ],
    1
  )
}

/** 每页一张图片（占页面上部约四分之三）加几行英文文字层（如图标题），模拟电子书中的插图页 */
export function makeImagePdf(pages: { jpeg: Buffer; w: number; h: number; text: string[] }[]): Buffer {
  const objs: Obj[] = []
  const add = (body: Obj): number => objs.push(body)
  const catalog = add('')
  const pagesObj = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const pg of pages) {
    const img = add(imageObj(pg.jpeg, pg.w, pg.h))
    const ih = Math.round((640 * pg.h) / pg.w) > 620 ? 620 : Math.round((640 * pg.h) / pg.w)
    const iw = Math.round((ih * pg.w) / pg.h)
    const ops = [`q ${iw} 0 0 ${ih} ${(612 - iw) / 2} ${792 - 40 - ih} cm /Im0 Do Q`]
    pg.text.forEach((l, i) => ops.push(`BT /F1 11 Tf 60 ${110 - i * 18} Td (${esc(l)}) Tj ET`))
    const stream = ops.join('\n')
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`
      )
    )
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  return serialize(objs, catalog)
}
