import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

export class Companion {
  constructor(options) {
    this.options = options
    this.pending = new Map()
    this.closed = false
  }

  connect() {
    if (this.closed) throw Error('Arena Desktop plugin has been stopped')
    if (this.child) return this.child
    const { command, args, cwd, env } = this.options
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    let diagnostic = ''
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096) })
    const fail = () => {
      if (this.child !== child) return
      this.child = null
      let message = 'Arena bridge companion disconnected. Check Python, the bridge installation path, and Connect Arena.'
      if (/\bWinError\s+10013\b/i.test(diagnostic)) {
        message = 'Windows denied access to port 8766 (WinError 10013). Check whether another service has reserved the port or Windows restricts its use, then open Connect Arena again.'
      } else if (/\b10048\b|EADDRINUSE|address already in use|port 8766/i.test(diagnostic)) {
        message = 'Port 8766 is busy. Stop the standalone Arena terminal or the other program using this port, then open Connect Arena again.'
      }
      const error = Error(message)
      for (const { reject } of this.pending.values()) reject(error)
      this.pending.clear()
      lines.close()
    }
    lines.on('line', line => {
      try {
        const msg = JSON.parse(line)
        const waiter = this.pending.get(msg.id)
        if (!waiter || msg.jsonrpc !== '2.0') throw Error('Unexpected companion response')
        this.pending.delete(msg.id)
        if (msg.error) waiter.reject(Error(msg.error.message))
        else waiter.resolve(msg.result)
      } catch { fail(); child.kill() }
    })
    child.once('error', fail)
    child.once('close', fail)
    child.stdin.on('error', fail)
    return child
  }

  async rpc(method, params = {}) {
    const child = this.connect()
    const id = randomUUID()
    const result = Promise.withResolvers()
    this.pending.set(id, result)
    const timeout = setTimeout(() => { if (this.pending.has(id)) child.kill() }, 15000)
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return await result.promise
    } finally { clearTimeout(timeout) }
  }

  async close() {
    this.closed = true
    const child = this.child
    if (!child) return
    const ended = new Promise(resolve => child.once('close', resolve))
    child.stdin.end()
    const timer = setTimeout(() => child.kill(), 3500)
    try { await ended } finally { clearTimeout(timer) }
  }
}
