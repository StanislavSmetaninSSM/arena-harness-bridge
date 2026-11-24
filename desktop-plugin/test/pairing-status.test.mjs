import assert from 'node:assert/strict'
import test from 'node:test'
import { pairingCommand } from '../pairing.mjs'

const arena = { provider: 'arena', model: 'agent-mode' }
const other = { provider: 'other', model: 'agent-mode' }
const pick = /select Arena Agent Mode|выберите (?:модель )?Arena Agent Mode/i
const bind = /Bind conversation/i
const send = /message field|поле сообщения/i

async function run({ chat, pause, pairingState, after, beforeModel = arena, afterModel = beforeModel }) {
  let selected = beforeModel
  let instructions
  const methods = []
  const companion = { async rpc(method, params) {
    methods.push(method)
    assert.deepEqual(params, { sessionId: 'owner' })
    if (method === 'setup') return { pairToken:'test-secret', chat, pause,
      pairingState:pairingState ?? (!chat ? 'unpaired' : pause ? 'paused' : 'paired'), port:8766 }
    assert.equal(method, 'pairStatus')
    return { state: after }
  } }
  const command = pairingCommand(companion, async setup => {
    instructions = setup.instructions
    selected = afterModel
    return 'close'
  })
  const result = await command.handler({
    agent: { session: { id: 'owner' }, model: { current: () => selected } }, rawInput:'',
  })
  assert.doesNotMatch(result.text, /test-secret|https:\/\/arena\.ai/)
  return { instructions, receipt:result.text, methods }
}

test('returning to the paired Arena conversation only asks the user to send a message', async () => {
  const { instructions, receipt, methods } = await run({ chat:'https://arena.ai/agent/a', after:'paired' })
  for (const text of [instructions, receipt]) {
    assert.match(text, send)
    assert.doesNotMatch(text, pick)
    assert.doesNotMatch(text, /arena-reset|Bind conversation/i)
  }
  assert.deepEqual(methods, ['setup', 'pairStatus'])
})

test('closing the dialog reflects a new binding and the current choice of model', async () => {
  const { instructions, receipt } = await run({ chat:null, after:'paired', beforeModel:other, afterModel:arena })
  assert.match(instructions, bind)
  assert.match(receipt, send)
  assert.doesNotMatch(receipt, pick)
  const changed = await run({ chat:'https://arena.ai/agent/a', after:'paired', afterModel:other })
  assert.match(changed.receipt, pick)
})

test('unpaired, paused and switched owners get relevant next steps', async () => {
  const unpaired = await run({ chat:null, after:'unpaired' })
  assert.match(unpaired.receipt, bind)
  const paused = await run({ chat:'https://arena.ai/agent/a', pause:'Inspect the original chat', after:'paused' })
  assert.match(paused.instructions, /paused|приостанов/i)
  assert.match(paused.receipt, /paused|приостанов/i)
  const switched = await run({ chat:'https://arena.ai/agent/a', after:'otherSession' })
  assert.match(switched.receipt, /другом|другим|another Desktop/i)
  for (const text of [unpaired.receipt, paused.receipt, switched.receipt]) assert.doesNotMatch(text, pick)
})

test('a saved pairing with an offline browser gives same-chat recovery steps', async () => {
  const { instructions, receipt } = await run({ chat:'https://arena.ai/agent/a', pairingState:'offline', after:'offline' })
  for (const text of [instructions, receipt]) {
    assert.match(text, bind)
    assert.match(text, /original Arena tab|исходн(ую|ой) вкладк/)
    assert.doesNotMatch(text, pick)
    assert.doesNotMatch(text, /arena-reset/)
  }
})

test('a restored binding without a browser check is described as unconfirmed', async () => {
  const { instructions, receipt } = await run({ chat:'https://arena.ai/agent/a', pairingState:'unconfirmed', after:'unconfirmed' })
  for (const text of [instructions, receipt]) {
    assert.match(text, /waiting for|ожидает|ещё не подтвердил/i)
    assert.match(text, /if the extension asks|если расширение просит/i)
    assert.doesNotMatch(text, pick)
  }
})

test('an older external companion can still pair without claiming a verified final status', async () => {
  let opened = false
  const command = pairingCommand({
    async rpc(method) {
      if (method === 'setup') return { chat:'https://arena.ai/agent/a', pairToken:'test-secret', port:8766 }
      throw Error('Unknown Desktop method')
    }
  }, async () => { opened = true; return 'close' })
  const result = await command.handler({ agent:{session:{id:'owner'}, model:{current:() => arena}}, rawInput:'' })
  assert.equal(opened, true)
  assert.match(result.text, /update.*companion|обновите.*компаньон/i)
  assert.doesNotMatch(result.text, /test-secret|уже привязан|select arena/i)
})
