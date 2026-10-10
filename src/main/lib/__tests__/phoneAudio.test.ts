import { expect, it } from 'vitest'
import { readFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { startPhoneServer, signature, MAX_AUDIO_BYTES } from '../../services/capture/phoneServer'

it('音频流式交付临时文件，外部文件名只作为显示数据', async () => {
  let payload = Buffer.alloc(0),
    displayed = ''
  const server = await startPhoneServer({
    host: '127.0.0.1',
    decode: async () => true,
    receive: async () => {},
    decodeAudio: async () => true,
    receiveAudio: async (file) => {
      payload = await readFile(file.path)
      displayed = file.name
    }
  })
  try {
    const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(24)])
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', 'x-filename': encodeURIComponent('../../malicious.wav') },
      body: bytes
    })
    expect(response.status).toBe(201)
    expect(payload).toEqual(bytes)
    expect(displayed).toBe('../../malicious.wav')
  } finally {
    await server.stop()
  }
})
it('音频假签名拒绝，不把文件交给归档服务', async () => {
  let received = false
  const server = await startPhoneServer({
    host: '127.0.0.1',
    decode: async () => true,
    receive: async () => {},
    decodeAudio: async () => true,
    receiveAudio: async () => {
      received = true
    }
  })
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4', 'x-filename': 'test.m4a' },
      body: new Uint8Array(100)
    })
    expect(response.status).toBe(415)
    expect(received).toBe(false)
  } finally {
    await server.stop()
  }
})
it('四种允许音频只接受对应签名', () => {
  expect(signature(Buffer.from('00000020667479704d344120', 'hex'), 'audio/mp4')).toBe(true)
  expect(signature(Buffer.from('4944330300', 'hex'), 'audio/mpeg')).toBe(true)
  expect(signature(Buffer.from('fffb9000', 'hex'), 'audio/mpeg')).toBe(true)
  expect(signature(Buffer.from('524946460000000057415645', 'hex'), 'audio/wav')).toBe(true)
  expect(signature(Buffer.from('1a45dfa3', 'hex'), 'audio/webm')).toBe(true)
  expect(signature(Buffer.from('524946460000000057454250', 'hex'), 'audio/wav')).toBe(false)
})
it('超过300MB的 chunked 音频中断、删除临时文件且不触发解码或接收', async () => {
  const before = new Set((await readdir(tmpdir())).filter((n) => n.startsWith('jiwei-phone-audio-')))
  let delivered = false,
    sent = 0
  const server = await startPhoneServer({
    host: '127.0.0.1',
    decode: async () => true,
    receive: async () => {},
    decodeAudio: async () => {
      delivered = true
      return true
    },
    receiveAudio: async () => {
      delivered = true
    }
  })
  const block = Buffer.alloc(1024 * 1024)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > MAX_AUDIO_BYTES + block.length) return controller.close()
      controller.enqueue(block)
      sent += block.length
    }
  })
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: stream,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' })
    expect(response.status).toBe(413)
    expect(delivered).toBe(false)
    await expect.poll(async () => (await readdir(tmpdir())).filter((n) => n.startsWith('jiwei-phone-audio-') && !before.has(n))).toEqual([])
  } finally {
    await server.stop()
  }
}, 20000)
