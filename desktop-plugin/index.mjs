import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArenaAdapter, route } from './provider.mjs'
import { Companion } from './companion.mjs'
import { pairingCommand, resetCommand } from './pairing.mjs'
import { registerToolHelp } from './tool-help.mjs'

export const name = 'arena-desktop'
export const inject = ['llm', 'commands', 'agents', 'sessionProjections', 'tools', 'systemPrompt']

export async function apply(ctx, config = {}) {
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  const bundledCompanion = existsSync(resolve(packageRoot, 'arena_terminal', 'desktop_provider.py'))
  const root = config.bridgeRoot || process.env.ARENA_BRIDGE_ROOT || (bundledCompanion ? packageRoot : resolve(packageRoot, '..'))
  const command = config.python || process.env.ARENA_PYTHON || 'python'
  const allowed = ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'USERPROFILE', 'HOME', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'TMPDIR', 'DSH_HOME', 'ARENA_DESKTOP_STATE']
  const env = Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key, process.env[key]]))
  const companion = new Companion({ cwd: root, command, args: ['-u','-m','arena_terminal.desktop_provider'], env: {...env, PYTHONUTF8:'1'} })
  ctx.effect(() => () => companion.close())
  const adapter = new ArenaAdapter(ctx, companion)
  await adapter.galleryProjection
  registerToolHelp(ctx)
  ctx.on('tools/result', (exec, result) => { adapter.recordShellResult(exec, result) })
  ctx.llm.registerAdapter([route], adapter)
  ctx.commands.register(pairingCommand(companion))
  ctx.commands.register(resetCommand(companion))
}
