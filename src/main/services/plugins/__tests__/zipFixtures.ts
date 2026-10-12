import { crc32 } from 'zlib'

/** 自写 stored ZIP，保留中央/本地安全原名与 CRC 正确的 Unicode Path 扩展。 */
export function unicodePathZip(entries: { name: string; unicodeName?: string; content?: string; directory?: boolean }[]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      body = Buffer.from(entry.content ?? 'self-authored fixture')
    const unicode = entry.unicodeName === undefined ? undefined : Buffer.from(entry.unicodeName)
    const extra = Buffer.alloc(unicode ? 9 + unicode.length : 0)
    if (unicode) {
      extra.writeUInt16LE(0x7075, 0)
      extra.writeUInt16LE(5 + unicode.length, 2)
      extra[4] = 1
      extra.writeUInt32LE(crc32(name), 5)
      unicode.copy(extra, 9)
    }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(body), 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(body.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(extra.length, 28)
    local.push(header, name, extra, body)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(0x0314, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt32LE(crc32(body), 16)
    record.writeUInt32LE(body.length, 20)
    record.writeUInt32LE(body.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(extra.length, 30)
    record.writeUInt32LE(((entry.directory ? 0o40755 : 0o100644) << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name, extra)
    offset += header.length + name.length + extra.length + body.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
