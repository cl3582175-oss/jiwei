export const readingZh = {
  title:'对照阅读', original:'原文',parallel:'对照',translation:'译文',annotations:'按水平注释',
  start:'开始阅读',cancel:'取消',retry:'重试',costTitle:'开启对照阅读',
  cost:'本页约 {{characters}} 字符、{{paragraphs}} 段。全文翻译预估 {{cost}}；实际只翻你读到的部分，翻过的段落会缓存。',
  unknownCost:'服务商未公布可用计费标准',noModel:'设置对话模型后可翻译',skipCost:'以后不再提示费用',
  initialLevel:'你的英语水平',initialLevelHint:'只给超出这个水平的生词加注释，之后会根据你点“认识了”和查词自动微调。',levels:{cet4:'四级',cet6:'六级',ielts:'考研 / 雅思 6',advanced:'雅思 7+ / 专业阅读'},levelHints:{cet4:'约 4,000 词',cet6:'约 6,000 词',ielts:'约 8,000 词',advanced:'12,000 词以上'},customLevel:'自定义（词频前 {{count}}）',
  glossary:'生词本',recognize:'认识了',addWord:'加入生词本',addConcept:'加入概念',saved:'已加入生词本',recognized:'已记为认识的词',
  example:'原句',wordCard:'词语释义',openNote:'打开生词笔记',grammar:'讲语法',grammarCue:'「{{q}}」的句子结构',grammarQuestion:'请讲解选中外文的句子结构、成分和语法难点。',
  translating:'正在翻译',showOriginal:'展开原文',hideOriginal:'收起原文',translationLabel:'段落译文',
  threshold:'英语词汇水平',thresholdHint:'对照阅读只给超出这个水平的生词加注释；每收集 50 次“认识了”或查词，会自动微调一次（最多 10%）。',thresholdValue:'英语水平',saveThreshold:'保存',
  history:'调整记录',noHistory:'还没有调整记录',manual:'手动调整',automatic:'{{known}} 个认识、{{queried}} 个查询信号',signals:'已收集 {{count}} / 50 个信号',known:'已记录 {{count}} 个认识的词',
  cache:'翻译缓存',cacheHint:'缓存只存本机，不参与同步或知识库导出，最多 50 MB。',cacheSize:'{{entries}} 条 · {{size}}',clearCache:'清空翻译缓存',cacheCleared:'翻译缓存已清空',
  privacy:'敏感页面、无痕标签或仅本地资料不提供对照阅读。',pdfText:'PDF 对照文本',pdfPage:'第 {{page}} 页',
  pending:'提案等待确认',confirm:'确认写入生词本',pendingHint:'请核对词语、释义和原句。写入后可在笔记中撤销。',
  modelError:'阅读请求失败，可切换模式后重试。'
}
export const readingEn = {
  title:'Parallel reading',original:'Original',parallel:'Parallel',translation:'Translation',annotations:'Vocabulary annotations',
  start:'Start reading',cancel:'Cancel',retry:'Retry',costTitle:'Enable parallel reading',
  cost:'About {{characters}} characters in {{paragraphs}} paragraphs. Translating everything would cost about {{cost}}; only what you read is translated, and translated paragraphs are cached.',
  unknownCost:'Provider rates are unavailable',noModel:'Configure a chat model to translate',skipCost:'Do not show cost again',
  initialLevel:'Your English level',initialLevelHint:'Only words above this level are annotated; it adjusts as you mark words known or look them up.',levels:{cet4:'CET-4',cet6:'CET-6',ielts:'IELTS 6',advanced:'IELTS 7+ / professional'},levelHints:{cet4:'about 4,000 words',cet6:'about 6,000 words',ielts:'about 8,000 words',advanced:'12,000+ words'},customLevel:'Custom (top {{count}} words)',
  glossary:'Vocabulary notebook',recognize:'I know this',addWord:'Add to vocabulary',addConcept:'Add concept',saved:'Saved to vocabulary notebook',recognized:'Recorded as known',
  example:'Original sentence',wordCard:'Word meaning',openNote:'Open vocabulary note',grammar:'Grammar',grammarCue:'Sentence structure of “{{q}}”',grammarQuestion:'Explain the structure, components and grammatical difficulties of the selected foreign-language passage.',
  translating:'Translating',showOriginal:'Show original',hideOriginal:'Hide original',translationLabel:'Paragraph translation',
  threshold:'English vocabulary level',thresholdHint:'Only words above this level are annotated; every 50 known/look-up signals adjust it by at most 10%.',thresholdValue:'English level',saveThreshold:'Save',
  history:'Adjustment history',noHistory:'No adjustments yet',manual:'Manual adjustment',automatic:'{{known}} recognized and {{queried}} queried words',signals:'{{count}} / 50 signals collected',known:'{{count}} known words recorded',
  cache:'Translation cache',cacheHint:'The cache stays on this device, is excluded from sync and export, and is limited to 50 MB.',cacheSize:'{{entries}} entries · {{size}}',clearCache:'Clear translation cache',cacheCleared:'Translation cache cleared',
  privacy:'Parallel reading is unavailable for sensitive, incognito or local-only material.',pdfText:'PDF reading text',pdfPage:'Page {{page}}',
  pending:'Proposal awaiting confirmation',confirm:'Confirm vocabulary entry',pendingHint:'Check the word, meaning and original sentence. You can undo the write in the note.',
  modelError:'Reading request failed. Switch modes to retry.'
}
