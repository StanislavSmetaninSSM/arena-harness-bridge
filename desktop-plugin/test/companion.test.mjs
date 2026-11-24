import assert from 'node:assert/strict'
import test from 'node:test'
import { Companion } from '../companion.mjs'

// Stand-ins for the Python companion: wait for the first request, write a diagnostic, exit.
const dying = diagnostic => new Companion({ command:process.execPath, cwd:process.cwd(),
  args:['-e', `process.stdin.once('data', () => process.stderr.write(${JSON.stringify(diagnostic)}, () => process.exit(1)))`] })

for (const diagnostic of [
  'OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted',
  'OSError: [Errno 98] Address already in use',
]) test('a companion that cannot bind reports the busy port: ' + diagnostic.split(']')[0] + ']', async () => {
  const child = dying(diagnostic)
  try { await assert.rejects(child.rpc('setup'), /^Error: Port 8766 is busy\. Stop the standalone Arena terminal or the other program/) }
  finally { await child.close() }
})

test('WinError 10013 reports Windows denying access even when stderr mentions the port', async () => {
  const child = dying('Listening on port 8766\nPermissionError: [WinError 10013] Access denied')
  try {
    await assert.rejects(child.rpc('setup'), {
      message: 'Windows denied access to port 8766 (WinError 10013). Check whether another service has reserved the port or Windows restricts its use, then open Connect Arena again.',
    })
  } finally { await child.close() }
})

test('a companion that dies for another reason is not reported as a busy port', async () => {
  const child = dying("ModuleNotFoundError: No module named 'arena_terminal'")
  try { await assert.rejects(child.rpc('setup'), /^Error: Arena bridge companion disconnected/) }
  finally { await child.close() }
})
