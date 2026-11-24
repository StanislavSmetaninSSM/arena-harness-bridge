import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArenaAdapter, route } from './provider.mjs'
import { Companion, companionOptions } from './companion.mjs'
import { pairingCommand, resetCommand } from './pairing.mjs'
import { registerToolHelp } from './tool-help.mjs'

export const name = 'arena-desktop'
export const inject = ['llm', 'commands', 'agents', 'sessionProjections', 'tools', 'systemPrompt']

export async function apply(ctx, config = {}) {
  const packageRoot = dirname(fileURLToPath(import.meta.url))
  const companion = new Companion(companionOptions(packageRoot, config))
  ctx.effect(() => () => companion.close())
  const adapter = new ArenaAdapter(ctx, companion)
  await adapter.galleryProjection
  registerToolHelp(ctx)
  ctx.on('tools/result', (exec, result) => { adapter.recordShellResult(exec, result) })
  ctx.llm.registerAdapter([route], adapter)
  ctx.commands.register(pairingCommand(companion))
  ctx.commands.register(resetCommand(companion))
}
