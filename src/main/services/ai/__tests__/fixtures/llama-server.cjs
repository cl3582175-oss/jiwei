// Transport/process test double only; this fixture is never a model-quality acceptance source.
const http = require('node:http')
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
const cpu = value('-ngl') === '0'
const failure = value('--fixture-failure')
if (args.includes('--fixture-trace')) fs.appendFileSync(value('--fixture-trace'), JSON.stringify({ args, pid: process.pid }) + '\n')
if (failure === 'both' || (!cpu && failure === 'launch')) {
  process.stderr.write('fixture GPU initialization failure\n')
  process.exit(1)
}
process.stderr.write(
  cpu
    ? 'load_tensors: offloaded 0/25 layers to GPU\n'
    : 'llama_model_load: using device Metal (Fixture GPU) - 12000 MiB free\nload_tensors: offloaded 25/25 layers to GPU\n'
)
const pending = []
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/health') {
      res.statusCode = !cpu && failure === 'health' ? 503 : 200
      if (args.includes('--fixture-health-delay')) setTimeout(() => res.end('{}'), Number(value('--fixture-health-delay')))
      else res.end('{}')
      return
    }
    if (!cpu && req.url === '/crash' && failure === 'crash') process.exit(2)
    const send = () => res.end(JSON.stringify({ cpu, args, pid: process.pid, fixture: true }))
    if (req.url === '/wait') {
      pending.push(send)
      if (args.includes('--fixture-waiting')) fs.writeFileSync(value('--fixture-waiting'), 'waiting')
      return
    }
    if (req.url === '/release') {
      pending.splice(0).forEach((send) => send())
      send()
      return
    }
    if (req.url === '/slow') {
      const timer = setTimeout(send, 1000)
      req.on('close', () => clearTimeout(timer))
      return
    }
    send()
  })
  .listen(Number(value('--port')), '127.0.0.1')
