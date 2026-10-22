#!/usr/bin/env node
// 端到端测试用的 Chrome 替身：只实现 /json/version 与 Storage.getCookies。
// 文件 FAKE_CHROME_LOGIN_FILE 存在时，视为用户已在“Chrome”里登录。
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=').slice(1).join('=')
const port = Number(arg('remote-debugging-port'))
fs.appendFileSync(process.env.FAKE_CHROME_LOG, JSON.stringify({ profile: arg('user-data-dir'), port, pid: process.pid }) + '\n')
fs.writeFileSync(arg('user-data-dir') + '/Local State', '{}')

const cookies = () => {
  const base = { path: '/', expires: 1900000000, secure: true, httpOnly: true, sameSite: 'None' }
  const loggedIn = fs.existsSync(process.env.FAKE_CHROME_LOGIN_FILE)
  return [
    { ...base, name: 'NID', value: 'n', domain: '.google.com' },
    { ...base, name: 'OTHER', value: 'x', domain: '.example.com' },
    ...(loggedIn
      ? [
          { ...base, name: 'SID', value: 'sid-value', domain: '.google.com' },
          { ...base, name: 'LOGIN_INFO', value: 'yt', domain: '.youtube.com' }
        ]
      : [])
  ]
}

const frame = (text) => {
  const body = Buffer.from(text)
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
  return Buffer.concat([head, body])
}
const server = http.createServer((req, res) => {
  if (req.url === '/json/version') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }))
  } else res.writeHead(404).end()
})
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.on('data', (buf) => {
    if ((buf[0] & 15) === 8) return socket.end()
    let len = buf[1] & 127
    let off = 2
    if (len === 126) {
      len = buf.readUInt16BE(2)
      off = 4
    }
    const mask = buf.subarray(off, off + 4)
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]))
    const msg = JSON.parse(payload.toString())
    socket.write(frame(JSON.stringify({ id: msg.id, result: { cookies: cookies() } })))
  })
  socket.on('error', () => {})
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
