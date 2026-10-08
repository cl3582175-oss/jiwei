// 生成测试用 PDF（无依赖）：每页若干行英文文本，使用内置 Helvetica 字体，并画一个图形方块（供框选测试）。

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export function makePdf(pages: string[][]): Buffer {
  const objs: string[] = []
  const add = (body: string): number => objs.push(body)
  const catalog = add('') // 占位：1
  const pagesObj = add('') // 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const lines of pages) {
    const text = lines.map((l, i) => `BT /F1 14 Tf 60 ${740 - i * 24} Td (${esc(l)}) Tj ET`).join('\n')
    // 一个灰色方块和一行标签（模拟图表）
    const stream = `${text}\n0.85 0.9 0.88 rg 60 320 220 140 re f\nBT /F1 12 Tf 80 380 Td (Figure: retention curve) Tj ET`
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
      )
    )
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
