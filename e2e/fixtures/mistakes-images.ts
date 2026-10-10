import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'

export const MATH_QUESTION = 'Solve $x^2 - 5x + 6 = 0$.'
export const MATH_MY_ANSWER = 'D = 25 - 24 = 9; x = (5 ± 3)/2 = 1, 4.'
export const PHYSICS_QUESTION = 'A 2 kg body accelerates at 3 m/s². Find the resultant force.'
export const PHYSICS_MY_ANSWER = 'F = 2 + 3 = 5 N.'
/** 三张素材在测试中由canvas生成，字形和布局不是伪造OCR文本。 */
export function makeMistakeImages(): Record<'math' | 'physics' | 'multi', { path: string; bytes: Uint8Array }> {
  const directory = resolve('e2e/fixtures')
  mkdirSync(directory, { recursive: true })
  const result = {} as Record<'math' | 'physics' | 'multi', { path: string; bytes: Uint8Array }>
  for (const kind of ['math', 'physics', 'multi'] as const) {
    const width = { math: 1200, physics: 1180, multi: 1220 }[kind], height = kind === 'multi' ? 1000 : 500
    const canvas = createCanvas(width, height), context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height)
    context.fillStyle = '#111111'; context.font = '30px Arial'
    const math = ['1. Solve x² - 5x + 6 = 0.', 'My answer:', 'D = 25 - 24 = 9;', 'x = (5 ± 3)/2 = 1, 4.']
    const physics = ['2. A 2 kg body accelerates at 3 m/s².', 'Find the resultant force.', 'My answer: F = 2 + 3 = 5 N.', 'Correct answer: 6 N.', 'Solution: F = ma = 2 × 3 = 6 N.']
    const lines = kind === 'math' ? math : kind === 'physics' ? physics : [...math, '', '', ...physics]
    for (const [i, line] of lines.entries()) context.fillText(line, 55, 65 + i * 64)
    const path = resolve(directory, `mistakes-${kind}.png`), bytes = new Uint8Array(canvas.toBuffer('image/png'))
    writeFileSync(path, bytes); result[kind] = { path, bytes }
  }
  return result
}
