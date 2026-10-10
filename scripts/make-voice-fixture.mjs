import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

// 固定三种中文系统声音与说话顺序；结果用作假麦克风输入，不能替代真实会议验收。
const ffmpeg = process.env.JIWEI_FFMPEG || join(homedir(), 'Library/Application Support/jiwei-models/ffmpeg/ffmpeg')
const temp = mkdtempSync(join(tmpdir(), 'jiwei-voice-fixture-'))
const speech = [
  ['Tingting', '今天讨论积微。我们使用 FSRS 安排复习。'],
  ['Meijia', '我来补充课堂安排。学习后一天回忆关键概念。'],
  ['Sinji', '我负责接下来的行动。请把专业术语加入热词。'],
  ['Tingting', '间隔重复需要保留原声，再核对说话人的名字。'],
  ['Meijia', '今天决定下周试用积微，检查复习的效果。'],
  ['Sinji', '下次会议对照转写稿确认任务。谢谢大家。']
]
try {
  const args = [],
    durations = []
  for (const [i, [voice, text]] of speech.entries()) {
    const file = join(temp, `${i}.aiff`)
    execFileSync('say', ['-v', voice, '-r', '195', '-o', file, text])
    args.push('-i', file)
    const decoded = execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'])
    durations.push(decoded.length / 32000)
  }
  const output = resolve('e2e/fixtures/meeting.wav')
  mkdirSync(resolve('e2e/fixtures'), { recursive: true })
  // 所有句子完整保留；超出 44 秒时整体略提速，再填充到 45 秒，不剪掉第三人。
  const gap = 3,
    tempo = Math.max(1, (durations.reduce((a, b) => a + b, 0) + gap * speech.length) / 44)
  const inputs = speech.map((_, i) => `[a${i}]`).join('')
  const pads = speech.map((_, i) => `[${i}:a]apad=pad_dur=${gap}[a${i}]`).join(';')
  execFileSync(ffmpeg, [
    '-nostdin',
    '-v',
    'error',
    ...args,
    '-filter_complex',
    `${pads};${inputs}concat=n=${speech.length}:v=0:a=1,atempo=${tempo},apad`,
    '-t',
    '45',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-y',
    output
  ])
  let start = 0
  const turns = speech.map(([voice, text], i) => {
    const end = start + durations[i] / tempo
    const turn = { voice, text, start, end }
    start = end + gap / tempo
    return turn
  })
  writeFileSync(resolve('e2e/fixtures/meeting.json'), JSON.stringify({ sampleRate: 16000, duration: 45, tempo, turns }, null, 2) + '\n')
  process.stdout.write(`${output}\n`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
