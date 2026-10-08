// 文档结构常量（主进程与编辑器共用）

/** 带永久 ID 的节点类型：段落级时间戳、批注锚点、RAG 分片都依赖它 */
export const ID_TYPES = [
  'cornellRow',
  'cornellSummary',
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'bulletList',
  'orderedList',
  'listItem',
  'horizontalRule',
  'image',
  'embed'
]
