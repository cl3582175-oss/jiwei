/* global require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- local CommonJS asset generator */
// DMG 窗口背景（680×480 与 @2x）。中文与英文分行绘制，避免混排字体时标点和间距不齐。
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const fonts = [
  ['/System/Library/Fonts/Hiragino Sans GB.ttc', 'JiweiSans'],
  ['/System/Library/Fonts/Supplemental/Songti.ttc', 'JiweiSerif'],
  ['/System/Library/Fonts/HelveticaNeue.ttc', 'JiweiLatin']
]
for (const [path, name] of fonts)
  if (!GlobalFonts.registerFromPath(path, name)) throw new Error(`Font required to regenerate the DMG background: ${path}`)

const W = 680,
  H = 480
for (const scale of [1, 2]) {
  const canvas = createCanvas(W * scale, H * scale)
  const c = canvas.getContext('2d')
  c.scale(scale, scale)
  const gradient = c.createLinearGradient(0, 0, W, H)
  gradient.addColorStop(0, '#f4f6ee')
  gradient.addColorStop(1, '#dfece6')
  c.fillStyle = gradient
  c.fillRect(0, 0, W, H)

  // 标题
  c.textAlign = 'center'
  c.fillStyle = '#155e59'
  c.font = '600 30px "JiweiSerif"'
  c.fillText('积 微', W / 2, 58)
  c.fillStyle = '#4f7a70'
  c.font = '13px "JiweiSans"'
  c.fillText('把积微拖到右边的「应用程序」文件夹', W / 2, 88)
  c.font = '12px "JiweiLatin"'
  c.fillText('Drag Jiwei to the Applications folder', W / 2, 106)

  // 图标位置由 electron-builder.yml 决定：(160, 220) 与 (520, 220)
  c.strokeStyle = '#7aa497'
  c.lineWidth = 2
  c.lineCap = 'round'
  c.beginPath()
  c.moveTo(292, 220)
  c.lineTo(388, 220)
  c.moveTo(378, 211)
  c.lineTo(388, 220)
  c.lineTo(378, 229)
  c.stroke()

  // 首次打开说明
  const x = 40,
    y = 336,
    w = W - 80,
    h = 104
  c.fillStyle = 'rgba(255,255,255,0.55)'
  c.strokeStyle = 'rgba(21,94,89,0.18)'
  c.lineWidth = 1
  c.beginPath()
  c.roundRect(x, y, w, h, 10)
  c.fill()
  c.stroke()
  c.textAlign = 'left'
  c.fillStyle = '#155e59'
  c.font = '600 13px "JiweiSans"'
  c.fillText('第一次打开时，如果提示「Apple 无法验证」', x + 18, y + 26)
  c.fillStyle = '#2f4f48'
  c.font = '12.5px "JiweiSans"'
  c.fillText('先点「完成」，再打开「系统设置 → 隐私与安全性」，在页面下方点「仍要打开」。只需一次。', x + 18, y + 49)
  c.fillStyle = '#5b7a72'
  c.font = '11.5px "JiweiLatin", "JiweiSans"'
  c.fillText('If macOS says Apple cannot verify the app: click Done, then open', x + 18, y + 72)
  c.fillText('System Settings → Privacy & Security and choose Open Anyway. Only needed once.', x + 18, y + 89)

  c.textAlign = 'right'
  c.fillStyle = '#7f9a92'
  c.font = '11px "JiweiSans"'
  c.fillText('青风铃 出品', W - 40, H - 16)
  writeFileSync(join(__dirname, '..', 'build', scale === 1 ? 'dmg-background.png' : 'dmg-background@2x.png'), canvas.toBuffer('image/png'))
}
