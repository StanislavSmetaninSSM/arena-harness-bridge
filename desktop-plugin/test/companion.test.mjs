import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Companion, companionOptions } from '../companion.mjs'

test('packaged Windows plugin uses its private Python and honors explicit developer overrides', t => {
  const project = mkdtempSync(join(tmpdir(), 'arena companion '))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const pkg = join(project, 'plugin')
  const companion = join(pkg, 'arena_terminal')
  const runtime = join(pkg, 'windows-python')
  mkdirSync(runtime, { recursive: true })
  const options = (config = {}, env = {}, platform = 'win32') => companionOptions(pkg, config, env, platform)
  assert.equal(options().command, 'python')
  assert.equal(options().cwd, project)
  mkdirSync(companion)
  writeFileSync(join(companion, 'desktop_provider.py'), '')
  assert.equal(options().cwd, pkg)
  assert.equal(options().command, 'python')
  const python = join(runtime, 'python.exe')
  writeFileSync(python, '')
  assert.equal(options().command, python)
  assert.equal(options({}, {}, 'linux').command, 'python')
  assert.equal(options({}, {ARENA_PYTHON:'from-env'}).command, 'from-env')
  assert.equal(options({python:'from-config'}, {ARENA_PYTHON:'from-env'}).command, 'from-config')
  assert.equal(options({bridgeRoot:project}, {ARENA_BRIDGE_ROOT:pkg}).cwd, project)
  assert.equal(options({}, {ARENA_BRIDGE_ROOT:project}).cwd, project)
})

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

test('a second Desktop serving the same state reports the profile conflict', async () => {
  const child = dying('RuntimeError: ARENA_DESKTOP_STATE_IN_USE')
  try { await assert.rejects(child.rpc('setup'), /already running for this Desktop profile/) }
  finally { await child.close() }
})

test('failure on the OS-selected port is distinguished from a busy default port', async () => {
  const child = dying('[WinError 10013] endpoint refused. ARENA_LOOPBACK_UNAVAILABLE')
  try { await assert.rejects(child.rpc('setup'), /could not open a local port automatically/) }
  finally { await child.close() }
})

test('a companion that dies for another reason is not reported as a busy port', async () => {
  const child = dying("ModuleNotFoundError: No module named 'arena_terminal'")
  try { await assert.rejects(child.rpc('setup'), /^Error: Arena bridge companion disconnected/) }
  finally { await child.close() }
})
