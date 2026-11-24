import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
if (!process.versions.electron) {
  const {register} = await import('../../harness-adapter/node_modules/tsx/dist/esm/api/index.mjs')
  register({tsconfig:fileURLToPath(new URL('../../deepseek-harness/tsconfig.json', import.meta.url))})
}

const { Context } = await import('@deepseek-ai/cordis')
const { default: SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await import('@deepseek-ai/dsh-tools')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { registerToolHelp, hasHelpHint } = await import('../tool-help.mjs')
const selection = {provider:'arena', model:'agent-mode'}
const signal = new AbortController().signal
const target = 'future_plugin_v2'
const secret = 'UNRELATED_PRIVATE_CONTENT'
const tool = (name, description) => ({name, description, parameters:{type:'object', required:['file'], properties:{file:{type:'string',description:'local file'}}},
  output:{schema:{type:'integer'},render:()=>[]},execute(){throw Error('Documented tool executed')}})

async function harness(t, ptc=false, parent) {
  const ctx = new Context()
  t.after(()=>ctx.fiber.dispose())
  await ctx.plugin((await import('@deepseek-ai/dsh-session')).default)
  await ctx.plugin((await import('@deepseek-ai/dsh-session-projection')).default)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin({name:'help-fixture', inject:['tools','systemPrompt'],apply:registerToolHelp})
  ctx.systemPrompt.section({name:'persona',order:4,text:secret})
  ctx.systemPrompt.context({name:'cwd',order:4,text:secret})
  const runCode = {name:'run_code',description:'Runtime syntax',parameters:{type:'object'}}
  if (ptc) ctx.tools.setExecutor({describe:()=>({schemas:[runCode]}),sections:[
    {name:'tools:sdk',order:5,text:defs=>'Native SDK\n'+defs.map(d=>d.name).join('\n')}]})
  else await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
  const { Session } = await import('@deepseek-ai/dsh-session')
  const agent = {session:Session.create('help-fixture')}
  const scope = createScope(ctx,agent,{parent})
  const prepare = async (selected=selection) => {
    const toolSet = await ctx.tools.resolve({agent,modelSelection:selected,signal})
    t.after(()=>toolSet.dispose())
    const exec = {agent,toolSet,signal}
    const assembly = await ctx.systemPrompt.assemble({...exec,scope:agent,modelSelection:selected})
    const help = toolSet.view(agent).get('arena_tool_help')
    return {exec,assembly,help,call:args=>help.execute(args,exec)}
  }
  return {ctx,agent,scope,prepare}
}

test('new registrations, native published instructions, schemas and removal follow actual step admission', async t=>{
  const {ctx,prepare} = await harness(t)
  const first = ctx.tools.register(tool(target,'First revision'))
  ctx.tools.register(tool('hidden','FORBIDDEN'),{when:()=>false})
  ctx.systemPrompt.section({name:'tool:'+target,order:4,text:'Published usage for '+target})
  ctx.systemPrompt.section({name:'tool:hidden',order:4,text:'FORBIDDEN '+target})
  const before = await prepare()
  assert.match((await before.call({})).text, new RegExp(target))
  const page = await before.call({name:target})
  for(const expected of ['First revision','local file','required','integer','Published usage']) assert.ok(page.text.includes(expected),expected)
  assert.doesNotMatch(page.text,/FORBIDDEN|UNRELATED_PRIVATE_CONTENT/)
  assert.equal(page.nextCursor,null)
  assert.doesNotMatch((await before.call({name:'hidden'})).text,/FORBIDDEN/)
  assert.equal((await prepare({provider:'other',model:'model'})).help,undefined)
  first()
  ctx.tools.register(tool(target,'Second revision'))
  assert.doesNotMatch((await before.call({name:target})).text,/First revision|Second revision|Published usage/)
  assert.match((await (await prepare()).call({name:target})).text,/Second revision/)
  await assert.rejects(before.help.execute({}, {...before.exec,toolSet:undefined}))
})

test('PTC discovery respects admitted help; SDK, transport and large pages come from current runtime',async t=>{
  const {ctx,scope,prepare} = await harness(t,true)
  const long = '🚀 sample '.repeat(1400)
  ctx.tools.register(tool(target,long))
  const {assembly,call} = await prepare()
  const flat = [{role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:renderPrompt(assembly)}]}]
  assert.ok(hasHelpHint(flat))
  assert.equal(hasHelpHint([{...flat[0],role:'user'}]),false)
  const hint = assembly.sections.find(s=>s.name==='arena:tool-help')
  const update = (state,text)=>({role:'system',source:{kind:'system-prompt',sections:[{state,name:hint.name,contentIndex:0}]},content:[{type:'text',text}]})
  assert.ok(hasHelpHint([update('active',hint.text)]))
  assert.equal(hasHelpHint([update('active',hint.text),update('retired','retired')]),false)
  assert.match((await call({sdk:true})).text,/Native SDK/)
  assert.match((await call({name:'run_code'})).text,/Runtime syntax/)
  let page = await call({name:target})
  const cursor = page.nextCursor
  assert.ok(cursor)
  let text = page.text
  while(page.nextCursor) {page=await call({name:target,cursor:page.nextCursor});text+=page.text}
  assert.ok(text.includes(long))
  await assert.rejects(call({name:'different',cursor}))
  const mask=await scope.ctx.plugin({name:'hide-help',inject:['tools'],apply(owner){owner.tools.restrict({deny:['arena_tool_help']})}})
  assert.equal(hasHelpHint([{...flat[0],content:[{type:'text',text:renderPrompt((await prepare()).assembly)}]}]),false)
  await mask.dispose()
})

test('published family guidance is discoverable, including families with unrelated tool names', async t=>{
  const {ctx,prepare} = await harness(t)
  ctx.tools.register(tool('future_create','Manage records'))
  ctx.tools.register(tool('hidden','PRIVATE'),{when:()=>false})
  ctx.systemPrompt.section({name:'tool:future',order:4,text:'Ask the user before scheduling.'})
  ctx.systemPrompt.section({name:'tool:unusual-family',order:4,text:'Shared instructions from this profile.'})
  ctx.systemPrompt.section({name:'tool:hidden',order:4,text:'PRIVATE future_create'})
  const {call} = await prepare()
  assert.match((await call({name:'future_create'})).text,/Ask the user/)
  assert.match((await call({})).text,/tool:unusual-family/)
  assert.match((await call({guide:'tool:unusual-family'})).text,/Shared instructions/)
  for (const guide of ['tool:hidden','persona','cwd','tools:sdk']) assert.doesNotMatch((await call({guide})).text,/PRIVATE|Shared instructions|Native SDK/)
})

test('changing registrations during native assembly invalidates the complete SDK page', async t=>{
  const {ctx,prepare} = await harness(t,true)
  const remove = ctx.tools.register(tool('ephemeral','Private after removal'))
  const {call} = await prepare()
  const pending = call({sdk:true})
  remove()
  await assert.rejects(pending,/changed/i)
  assert.doesNotMatch((await call({sdk:true})).text,/ephemeral/)
})

test('per-tool SDK uses the native program output adaptation', async t=>{
  const {ctx,prepare} = await harness(t,true)
  ctx.tools.register(tool('read_image','Read test image'))
  const {call} = await prepare()
  let page = await call({name:'read_image',sdk:true})
  let doc = page.text
  while(page.nextCursor) {page=await call({name:'read_image',sdk:true,cursor:page.nextCursor});doc+=page.text}
  assert.match(doc,/read_image: Image;/)
})

test('a child cannot reclassify a masked parent registration as a shared guide', async t=>{
  const parent = {}
  const {ctx,scope,prepare} = await harness(t,false,parent)
  const parentScope = createScope(ctx,parent)
  await parentScope.ctx.plugin({name:'parent-fixture',inject:['tools','systemPrompt'],apply(owner){
    owner.tools.register(tool('parent_secret','Parent only'))
    owner.systemPrompt.section({name:'tool:parent_secret',order:1,text:'Private parent guide for read.'})
  }})
  await scope.ctx.plugin({name:'restriction',inject:['tools'],apply(owner){owner.tools.restrict({deny:['parent_secret']})}})
  const {call} = await prepare()
  assert.doesNotMatch((await call({})).text,/parent_secret/)
  assert.doesNotMatch((await call({guide:'tool:parent_secret'})).text,/Private parent/)
})


for (const mode of ['native','ptc']) {
  test('Arena receives help from the Harness '+mode+' execution loop', {timeout:20000}, async t=>{
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ArenaAdapter } = await import('../provider.mjs')
    const { default:Llm,createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const root = await mkdtemp(join(tmpdir(),'arena-help-session-'))
    const ctx = new Context()
    t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
    await ctx.plugin(Llm)
    for (const service of ['session','session-projection','system-prompt','tools','agent','commands']) {
      await ctx.plugin((await import('@deepseek-ai/dsh-'+service)).default)
    }
    await ctx.plugin((await import('@deepseek-ai/dsh-fs-local')).default,{cwd:root})
    await ctx.plugin((await import('@deepseek-ai/dsh-working-directory')).default)
    if (mode==='ptc') {
      for (const service of ['subprocess-local','sandbox-local','sandbox-policy','ptc-runtime-node']) {
        await ctx.plugin((await import('@deepseek-ai/dsh-'+service)).default,service==='sandbox-policy' ? {mode:'danger-full-access'} : {})
      }
    }
    await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-'+mode))
    await ctx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default,{agents:[]})
    await ctx.plugin({name:'reference-registration',inject:['systemPrompt','tools'],apply:registerToolHelp})
    ctx.tools.register(tool(target,'Dynamic reference entry'))
    const requests = []
    const peer = {async rpc(method,request) {
      if (method==='setup') return {supportsComputerUseGuidance:true,supportsToolHelp:true,supportsResultView:true}
      if (method==='start') {requests.push(request);return {id:request.requestId}}
      const direct = {kind:'tool',name:'arena_tool_help',arguments:{name:target}}
      const nested = {kind:'tool',name:'run_code',arguments:{description:'Read current documentation',code:
        'const page = await tools.arena_tool_help({name:"future_plugin_v2"}); inspect(page.text)'}}
      return {state:'done',reply:requests.length===1 ? (mode==='native' ? direct : nested) : {kind:'text',text:'Done'}}
    }}
    ctx.llm.registerAdapter(['arena'],new ArenaAdapter(ctx,peer,1))
    const {agent} = await ctx.agents.create({sessionId:'help-'+mode,meta:{cwd:root},agentOptions:selection})
    agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Look up the new tool.'}]}))
    await agent.whenIdle()
    assert.equal(requests.length,2)
    assert.equal(requests[0].toolHelpViaCode===true,mode==='ptc')
    assert.equal(requests[0].tools.some(s=>s.name==='arena_tool_help'),mode==='native')
    const result=JSON.parse(requests[1].toolResult)
    assert.equal(result.failed,false,result.text)
    assert.match(result.text,/Dynamic reference entry/)
    assert.match(result.text,/local file/)
    assert.match(result.text,/integer/)
  })
}
