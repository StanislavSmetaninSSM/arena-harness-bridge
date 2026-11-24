import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function showPairing(setup, signal) {
  if (process.platform !== 'win32') throw Error('Connect Arena dialog currently requires Windows Desktop')
  const file = fileURLToPath(new URL('./pairing.ps1', import.meta.url))
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', file], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, signal,
  })
  return new Promise((resolve, reject) => {
    let action = ''
    child.stdout.on('data', chunk => { action += chunk })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(Error('Cannot display Connect Arena. Check Windows PowerShell and desktop access.'))
      else resolve(action.trim())
    })
    // Explicit human-only output; the Desktop Session records slash-command
    // return text, so credentials are never returned through that channel.
    child.stdin.end(JSON.stringify({
      token:setup.pairToken, chat:setup.chat, pause:setup.pause, port:setup.port,
      title:'Connect Arena / Подключить Arena',
      instructions:setup.instructions,
    }))
  })
}

function pairingInstructions(state, agent, dialog = false) {
  switch (state) {
    case 'unpaired':
      return dialog
        ? 'Copy the token. In the Arena tab, paste it into Arena Harness Bridge and click Bind conversation.\n\nСкопируйте токен. На вкладке Arena вставьте его в расширение Arena Harness Bridge и нажмите Bind conversation.'
        : 'Pairing is pending. Copy the token from /arena-pair and click Bind conversation in the extension.\nПривязка ожидает подтверждения. Скопируйте токен из /arena-pair и нажмите Bind conversation в расширении.'
    case 'otherSession':
      return 'Arena is paired with another Desktop conversation. Continue there.\nArena привязана к другому диалогу Desktop. Продолжите в нём.'
    case 'unconfirmed':
      return 'Pairing saved. Waiting for the original Arena tab. If the extension asks for a token, use the code from /arena-pair.\nПривязка сохранена. Браузер ещё не подтвердил связь. Откройте исходную вкладку Arena. Если расширение просит токен, используйте код из /arena-pair.'
    case 'offline':
      return dialog
        ? 'Open the original Arena tab. If the extension asks for a token, copy it here and click Bind conversation in the extension.\n\nОткройте исходную вкладку Arena. Если расширение просит токен, скопируйте его из этого окна и нажмите Bind conversation в расширении.'
        : 'Open the original Arena tab. If the extension asks for a token, copy it from /arena-pair and click Bind conversation there.\nОткройте исходную вкладку Arena. Если расширение просит токен, скопируйте его из /arena-pair и нажмите Bind conversation в расширении.'
    case 'paused':
      return dialog
        ? 'Delivery is paused. Check the original Arena tab and the status below.\n\nДоставка приостановлена. Проверьте исходную вкладку Arena и причину в строке состояния ниже.'
        : 'Delivery is paused. Check the original Arena tab and the status in /arena-pair.\nДоставка приостановлена. Проверьте исходную вкладку Arena и причину в окне /arena-pair.'
    case 'paired': {
      const current = agent.model.current()
      if (current?.provider === 'arena' && current.model === 'agent-mode') {
        return 'This conversation is paired. Use the normal message field in Desktop.\nЭтот диалог уже привязан. Напишите в обычном поле сообщения Desktop.'
      }
      return 'This conversation is paired. Select Arena Agent Mode in the model picker to send to Arena.\nЭтот диалог уже привязан. Чтобы написать в Arena, выберите модель Arena Agent Mode.'
    }
    default:
      throw Error('Could not read the Arena pairing status. Open /arena-pair to check it.')
  }
}

export function pairingCommand(companion, show = showPairing) {
  return {
    name: 'arena-pair',
    description: 'Connect Arena / Подключить Arena — pair the extension, view status or disconnect',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      if (rawInput.trim()) return {kind:'error',text:'Select Connect Arena or enter /arena-pair without arguments.'}
      const address = { sessionId: agent.session.id }
      const setup = await companion.rpc('setup', address)
      const state = setup.pairingState ?? (!setup.chat ? 'unpaired' : setup.pause ? 'paused' : 'unconfirmed')
      const instructions = pairingInstructions(state, agent, true)
      if (await show({ ...setup, instructions }, signal) === 'disconnect') {
        await companion.rpc('disconnect', address)
        return { kind:'success', text:'Disconnected Arena. Open Connect Arena to pair another conversation.' }
      }
      if (setup.pairingState === undefined) {
        return { kind:'success', text:'Pairing window closed. Update the configured bridge companion to see current status here.\nОкно подключения закрыто. Чтобы видеть здесь актуальный статус, обновите внешний компаньон моста.' }
      }
      const status = await companion.rpc('pairStatus', address)
      return { kind:'success', text:pairingInstructions(status.state, agent) }
    },
  }
}

export function resetCommand(companion) {
  return {
    name: 'arena-reset',
    description: 'Reset Arena / Сбросить Arena — clear the delivery queue and release the connection from any Desktop conversation',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      if (rawInput.trim()) return { kind:'error', text:'Enter /arena-reset without arguments.' }
      signal?.throwIfAborted()
      const result = await companion.rpc('reset', { sessionId:agent.session.id })
      if (result?.ok !== true) throw Error('The Arena companion did not confirm the reset.')
      return { kind:'success', text:'Привязка Arena сброшена. Для подключения выполните /arena-pair. / Arena connection reset. Run /arena-pair to reconnect.' }
    },
  }
}
