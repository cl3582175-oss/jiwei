import { expect, it } from 'vitest'
import { scanUiFences, annotateUiFences, uiAnswerText, mapOutsideFences } from '../fences'

it('按位置识别围栏，忽略普通代码里的 UI 字样，序号随流式追加稳定', () => {
  const one = '引言\n\n```jiwei-ui\n{"type":"list","items":[{"text":"甲"}]}\n```\n\n'
  const second = '~~~jiwei-ui\n{"type":"list","items":[{"text":"乙"}]}'
  const normal = '````text\n```jiwei-ui\n不是组件\n```\n````\n'
  const fences = scanUiFences(one + normal + second)
  expect(fences).toHaveLength(2)
  expect(fences.map((f) => [f.index, f.closed])).toEqual([
    [0, true],
    [1, false]
  ])
  expect(fences[0].start).toBe(scanUiFences(one)[0].start)
  expect(annotateUiFences(one + normal + second)).toContain('~~~jiwei-ui jiwei-index=1 jiwei-open=1')
  expect(uiAnswerText(one)).toBe('引言\n\n- 甲\n\n')
})
it('引用只处理正文，不改波浪线或四反引号里的 JSON 和代码', () => {
  const src = '引用 [1]\n~~~jiwei-ui\n{"cite":[1]}\n~~~\n\n````js\nconst a=[1]\n````\n再见 [2]'
  expect(mapOutsideFences(src, (text) => text.replace(/\[(\d+)\]/g, '[$1](#cite-$1)'))).toBe(
    '引用 [1](#cite-1)\n~~~jiwei-ui\n{"cite":[1]}\n~~~\n\n````js\nconst a=[1]\n````\n再见 [2](#cite-2)'
  )
})
