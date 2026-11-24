import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pairingCommand } from '../pairing.mjs'

const inspect = promisify(execFile)

test('the human pairing command opens a visible Windows dialog with its helper console hidden', {
  skip: process.platform !== 'win32' || process.env.ARENA_TEST_NATIVE_WINDOW !== '1',
  timeout: 25_000,
}, async () => {
  const controller = new AbortController()
  const peer = { rpc: async method => method === 'setup' ? { pairToken:'synthetic-ui-test', chat:null, pairingState:'unpaired', port:0 } : { state:'unpaired' } }
  const dialog = pairingCommand(peer).handler({ agent:{session:{id:'ui-test'}}, rawInput:'', signal:controller.signal })
  // Inspect and close only a top-level window created by this test process.
  const probe = `
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
      $owned = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'powershell.exe'"
      foreach ($child in $owned) {
        $window = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        if ($window.MainWindowHandle -ne 0 -and $window.MainWindowTitle -like 'Connect Arena*') {
          if ($window.CloseMainWindow()) { Write-Output 'visible-and-closed'; exit }
        }
      }
      Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Visible pairing dialog was not found'
  `
  try {
    const [{ stdout }, result] = await Promise.all([
      inspect('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',probe], { windowsHide:true }),
      dialog,
    ])
    assert.equal(stdout.trim(), 'visible-and-closed')
    assert.equal(result.kind, 'success')
  } finally {
    controller.abort()
    await dialog.catch(() => {})
  }
})
