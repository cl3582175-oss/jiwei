// Evaluated only inside the temporary Electron main harness.
export const pluginResponseGateHarness = `
// Test-only scheduling: run the registered production handler, then hold its real
// result. This does not replace acquisition, validation, tokens, or persisted state.
const { ipcMain } = require('electron')
const gates = (globalThis.p2ResponseGates = {})
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  handle(channel, async (...args) => {
    const gate = gates[channel]
    if (gate) delete gates[channel]
    const result = await listener(...args)
    if (gate) {
      gate.waiting = true
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Response gate timed out: ' + channel)), 15000)
        gate.release = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      gate.released = true
    }
    return result
  })
`
