/** 与索引写入共用正文资格，状态不能等待永远不会建立的短段向量。 */
export const isIndexableText = (text: string): boolean => text.trim().length >= 6
