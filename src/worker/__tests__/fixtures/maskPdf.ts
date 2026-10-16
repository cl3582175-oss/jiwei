/** 自造 1 bit 图像蒙版，保留与黑白扫描 PDF 相同的绘制分支；不包含用户资料。 */
export function makeMaskPdf(content = 'q 595 0 0 842 0 0 cm /Scan Do Q'): Buffer {
  const data = Buffer.alloc(128)
  for (let row = 0; row < 32; row++) data.fill(row % 4 < 2 ? 0x55 : 0xaa, row * 4, row * 4 + 4)
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
