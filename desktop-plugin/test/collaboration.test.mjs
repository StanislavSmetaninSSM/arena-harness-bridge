import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { register } from '../../harness-adapter/node_modules/tsx/dist/esm/api/index.mjs'

register({ tsconfig: fileURLToPath(new URL('../../deepseek-harness/tsconfig.json', import.meta.url)) })

const pkg = name => import('@deepseek-ai/dsh-' + name)

async function desktop(t, mount) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { ArenaAdapter } = await import('../provider.mjs')
  const { inject } = await import('../index.mjs')
  const { createUserMessage } = await pkg('llm')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const calls = []
  const errors = []
  for (const name of ['llm', 'session', 'session-projection', 'system-prompt', 'tools', 'agent', 'commands']) {
    await ctx.plugin((await pkg(name)).default)
  }
  await ctx.plugin(await pkg('tool-executor-native'))
  await ctx.plugin((await pkg('agent-loop')).default, { agents: [] })
  await mount(ctx)
  const replies = new Map()
  let answer = () => ({ kind: 'text', text: 'End of test step.' })
  const companion = {
    async rpc(method, args) {
      if (method === 'setup') return {supportsResultView:true,supportsOnDemandContext:true}
      if (method === 'start') {
        calls.push(args)
        replies.set(args.requestId, answer(args, calls.length))
        return { id: args.requestId }
      }
      assert.equal(method, 'status')
      return { state: 'done', reply: replies.get(args.id) }
    },
  }
  await ctx.plugin({
    name: 'arena-collaboration-fixture',
    inject,
    apply: scope => scope.llm.registerAdapter(['arena'], new ArenaAdapter(scope, companion, 1)),
  })
  ctx.on('agent/error', ({ error }) => errors.push(error))
  const { agent } = await ctx.agents.create({
    sessionId: 'arena-collaboration', agentOptions: { provider: 'arena', model: 'agent-mode' },
  })
  const command = async text => {
    const info = await ctx.commands.execute(agent, text, [], new AbortController().signal)
    assert.equal(info.result.kind, 'success')
    return info.result
  }
  const send = text => agent.followup(createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text }],
  }))
  return { ctx, agent, command, send, calls, errors, respond: fn => { answer = fn } }
}

const action = (name, args = {}) => ({ kind: 'tool', name, arguments: args })
const say = text => ({ kind: 'text', text })

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await delay(25)
  assert.ok(predicate(), 'Expected the native agent to reach the requested state')
}

test('a native goal sends two automatic rounds, accepts its own tool results, and stops when complete', async t => {
  const { ctx, agent, command, calls, errors, respond } = await desktop(t, async ctx => {
    await ctx.plugin((await pkg('goal')).default)
    await ctx.plugin(await pkg('goal-round-driver'))
    await ctx.plugin(await pkg('command-goal'))
    await ctx.plugin(await pkg('tool-goal'))
  })
  respond((_request, number) => {
    if (number === 1 || number === 3) return action('get_goal')
    if (number === 4) {
      const goal = ctx.goals.get(agent)
      return action('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' })
    }
    return say(number === 2 ? 'First round complete.' : 'Goal complete.')
  })
  await command('/goal Verify a synthetic objective with two rounds')
  await until(() => calls.length >= 5 || errors.length > 0)
  await agent.whenIdle()
  assert.deepEqual(errors, [])
  const rounds = calls.filter(request => request.text.includes('<goal_round>'))
  assert.equal(rounds.length, 2)
  assert.match(rounds[0].text, /Verify a synthetic objective with two rounds/)
  assert.match(rounds[1].text, /Verify a synthetic objective with two rounds/)
  assert.notEqual(rounds[0].requestId, rounds[1].requestId)
  assert.deepEqual(calls.map(request => Boolean(request.toolResult)), [false, true, false, true, true])
  assert.equal(ctx.goals.get(agent).phase, 'complete')
  assert.equal(ctx.goals.get(agent).roundsStarted, 2)
})

test('plan state follows native approval, rejection, and manual exit on subsequent requests', async t => {
  const { ctx, agent, command, send, calls, errors, respond } = await desktop(t, async ctx => {
    await ctx.plugin((await pkg('user-questions')).default)
    await ctx.plugin((await pkg('plan-mode')).default, { section: 'Private native system instruction.' })
  })
  const reviews = []
  ctx.on('user-questions/request', ({ questions: [question] }) => {
    reviews.push(question)
    const option = question.options[reviews.length === 1 ? 1 : 0]
    return { answers: [{ id: question.id, selected: [option.label] }] }
  })
  respond((_request, number) => number <= 2
    ? action('exit_plan_mode', { plan: '# Attachment experiment\n\nPlan details.' })
    : say('Step complete.'))
  await command('/plan Prepare the synthetic plan')
  await agent.whenIdle()
  assert.deepEqual(errors, [])
  assert.equal(reviews.length, 2)
  assert.ok(reviews.every(question => question.intent?.kind === 'plan-review'))
  assert.match(JSON.parse(calls[1].toolResult).text, /keep planning/i)
  assert.match(JSON.parse(calls[2].toolResult).text, /Plan approved/i)
  assert.deepEqual(calls.map(request => request.planMode), [true, true, false])
  assert.doesNotMatch(JSON.stringify(calls), /Private native system instruction/)
  await command('/plan')
  send('Continue preparing the plan')
  await agent.whenIdle()
  await command('/plan off')
  send('Continue in ordinary mode')
  await agent.whenIdle()
  assert.deepEqual(calls.map(request => request.planMode), [true, true, false, true, false])
})
