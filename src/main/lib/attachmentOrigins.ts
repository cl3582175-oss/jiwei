import * as Y from 'yjs'

const FIELD = 'attachmentSourceIds'
export function attachmentOrigins(state: Uint8Array): string[] {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return doc
      .getArray<string>(FIELD)
      .toArray()
      .filter((id) => typeof id === 'string')
  } finally {
    doc.destroy()
  }
}

/** 整体替换正文不能使来源消失；恢复旧内容也不视为归档授权。 */
export function retainAttachmentOrigins(previous: Uint8Array, next: Uint8Array): Uint8Array {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, next)
    const origins = doc.getArray<string>(FIELD)
    const known = new Set(origins.toArray())
    const extra = attachmentOrigins(previous).filter((id) => !known.has(id))
    if (!extra.length) return next
    origins.push(extra)
    return Y.encodeStateAsUpdate(doc)
  } finally {
    doc.destroy()
  }
}

export function addAttachmentOrigins(state: Uint8Array, sourceIds: string[]): Uint8Array | null {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    const before = Y.encodeStateVector(doc)
    const origins = doc.getArray<string>(FIELD),
      known = new Set(origins.toArray())
    const extra = [...new Set(sourceIds)].filter((id) => !known.has(id))
    if (!extra.length) return null
    origins.push(extra)
    return Y.encodeStateAsUpdate(doc, before)
  } finally {
    doc.destroy()
  }
}
