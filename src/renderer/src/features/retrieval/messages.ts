export const retrievalZh = {
  proactiveUnavailable: '本轮不能主动联网搜索，请根据已有资料回答。',
  proactiveSearchFailed: '本轮联网搜索失败，请根据已有资料回答。',
  proactiveReadFailed: '网页读取失败，请根据其他资料回答。',
  passageSelection: '（共 {{total}} 段，这里是最相关的 {{k}} 段）',
  passageLowRelevance: '（这些段落和问题的相关度较低）',
  toolsReliable: '工具调用：可靠',
  toolsUnreliable: '工具调用：不可靠',
  toolsHelp: '不可靠时，积微会先替模型搜索好再交给它'
}

export const retrievalEn = {
  proactiveUnavailable: 'Proactive web search is unavailable this turn. Answer from the available material.',
  proactiveSearchFailed: 'Web search failed this turn. Answer from the available material.',
  proactiveReadFailed: 'Page reading failed. Answer from other available material.',
  passageSelection: '(Total {{total}} passages; the {{k}} most relevant are shown)',
  passageLowRelevance: '(These passages have low relevance to the question)',
  toolsReliable: 'Tools: reliable',
  toolsUnreliable: 'Tools: unreliable',
  toolsHelp: 'When tool calls are unreliable, Jiwei searches first and then gives the results to the model'
}
