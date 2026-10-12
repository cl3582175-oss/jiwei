/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- local CommonJS asset generator */
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

if (!GlobalFonts.registerFromPath('/System/Library/Fonts/STHeiti Medium.ttc', 'JiweiDMG'))
  throw new Error('A full Chinese font is required to regenerate the DMG background')

for (const scale of [1, 2]) {
  const canvas = createCanvas(680 * scale, 480 * scale)
  const c = canvas.getContext('2d')
  c.scale(scale, scale)
  const gradient = c.createLinearGradient(0, 0, 680, 480)
  gradient.addColorStop(0, '#f3f5eb')
  gradient.addColorStop(1, '#dcebe5')
  c.fillStyle = gradient
  c.fillRect(0, 0, 680, 480)
  c.fillStyle = '#155e59'
  c.font = '34px "JiweiDMG", sans-serif'
  c.fillText('积微 · Jiwei', 42, 62)
  c.font = '15px "JiweiDMG", sans-serif'
  c.fillText('将积微拖到“应用程序” · Drag Jiwei to Applications', 42, 98)
  c.strokeStyle = '#67988b'
  c.lineWidth = 2
  c.beginPath()
  c.moveTo(288, 220)
  c.lineTo(392, 220)
  c.lineTo(381, 211)
  c.moveTo(392, 220)
  c.lineTo(381, 229)
  c.stroke()
  c.fillStyle = '#234b43'
  c.font = '14px "JiweiDMG", sans-serif'
  for (const [i, text] of [
    '首次打开如果提示无法验证开发者：',
    '打开“系统设置 → 隐私与安全性”，点“仍要打开”。',
    'If Apple cannot verify the developer, open System Settings →',
    'Privacy & Security, then choose Open Anyway.'
  ].entries())
    c.fillText(text, 42, 364 + i * 23)
  writeFileSync(join(__dirname, '..', 'build', scale === 1 ? 'dmg-background.png' : 'dmg-background@2x.png'), canvas.toBuffer('image/png'))
}
