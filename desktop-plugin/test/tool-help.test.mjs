import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
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
    {name:'tools:sdk',order:5,text:typeof ptc === 'function' ? ptc : defs=>'Native SDK\n'+defs.map(d=>d.name).join('\n')}]})
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
  assert.doesNotMatch((await call({name:'future_create'})).text,/Ask the user/)
  assert.match((await call({guide:'tool:future'})).text,/Ask the user/)
  assert.match((await call({})).text,/tool:unusual-family/)
  assert.match((await call({guide:'tool:unusual-family'})).text,/Shared instructions/)
  for (const guide of ['tool:hidden','persona','cwd','tools:sdk']) assert.doesNotMatch((await call({guide})).text,/PRIVATE|Shared instructions|Native SDK/)
})

test('named tool help omits incidental mentions from the terminal panel and other tool guides', async t=>{
  const {ctx,prepare} = await harness(t)
  ctx.tools.register(tool('read','Read a file'))
  ctx.tools.register(tool('bash','Run a shell command'))
  const removeCua = ctx.tools.register(tool('cua','Computer Use'))
  const panel = 'Once the user types into one, you can only read it. Keep using bash for short commands whose output you need now.'
  ctx.systemPrompt.section({name:'tool:pty-panel',order:4,text:panel})
  ctx.systemPrompt.section({name:'tool:cua',order:4,text:'CUA instructions that mention read.'})
  const {call} = await prepare()
  for (const name of ['read','bash']) assert.doesNotMatch((await call({name})).text,/CUA instructions|you can only read it/)
  assert.match((await call({})).text,/tool:pty-panel/)
  assert.equal((await call({guide:'tool:pty-panel'})).text,panel)
  assert.match((await call({name:'cua'})).text,/CUA instructions/)
  removeCua()
  assert.doesNotMatch((await call({name:'read'})).text,/CUA instructions/)
  assert.doesNotMatch((await call({guide:'tool:cua'})).text,/CUA instructions/)
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
  const {renderToolsSdk} = await import('@deepseek-ai/dsh-tool-executor-ptc')
  const {ctx,prepare} = await harness(t,defs=>renderToolsSdk(defs.map(d=>({...d,output:d.output.schema}))))
  ctx.tools.register(tool('read_image','Read test image'))
  ctx.tools.register(tool('write_file','Unrelated binding'))
  const {call} = await prepare()
  const wholeSdk = await fullHelp(call,{sdk:true})
  // The same fixture produces Image in alpha.2 and its canonical number in rc.5.
  const binding = /read_image: (?:Image|number);/.exec(wholeSdk)
  assert.ok(binding)
  const doc = await fullHelp(call,{name:'read_image',sdk:true})
  assert.ok(doc.includes(binding[0]))
  assert.doesNotMatch(doc,/write_file|Unrelated binding/)
})

test('single binding SDK follows the active executor language', async t=>{
  const {ctx,prepare} = await harness(t,defs=>defs.map(d=>`async def ${d.name}(args): ...`).join('\n'))
  ctx.tools.register(tool('read','Read a file'))
  ctx.tools.register(tool('other','Unrequested'))
  const {call} = await prepare()
  assert.equal(await fullHelp(call,{name:'read',sdk:true}),'async def read(args): ...')
})

async function fullHelp(call, query) {
  let page = await call(query)
  let document = page.text
  while (page.nextCursor) {
    page = await call({...query,cursor:page.nextCursor})
    document += page.text
  }
  return document
}

const cuaTopic = 'computer-use:dsh-cua'
for (const [ptc, cuaName] of [[false,'cua_run_code'],[true,'cua']]) {
  test('only an explicit query reads the current Computer Use guide for '+cuaName, async t=>{
    const {ctx,prepare} = await harness(t,ptc)
    const removeTool = ctx.tools.register(tool(cuaName,'Control a desktop'))
    ctx.tools.register(tool('read','Read a local file'))
    let guidance = 'Desktop guide mentioning read and run_code\n'+'操作🚀'.repeat(1200)
    const removeGuide = ctx.systemPrompt.section({name:cuaTopic,order:4,text:()=>guidance})
    const {call} = await prepare()
    assert.ok((await fullHelp(call,{})).includes(cuaTopic))
    for (const query of [{},{name:'read'},{name:'run_code'},{sdk:true},{name:'read',sdk:true}])
      assert.doesNotMatch(await fullHelp(call,query),/Desktop guide|操作|UNRELATED_PRIVATE_CONTENT/)
    assert.equal(await fullHelp(call,{guide:cuaTopic}),guidance)
    assert.ok((await fullHelp(call,{name:cuaName})).includes(guidance))
    const first = await call({guide:cuaTopic})
    guidance = 'Updated scope-specific reference'
    await assert.rejects(call({guide:cuaTopic,cursor:first.nextCursor}),/changed/)
    assert.equal(await fullHelp(call,{guide:cuaTopic}),guidance)
    removeGuide()
    assert.match(await fullHelp(call,{name:cuaName}),/Computer Use.*unavailable/i)
    ctx.systemPrompt.section({name:cuaTopic,order:4,text:'Detached reference, never disclose'})
    removeTool()
    assert.doesNotMatch(await fullHelp(call,{}),/computer-use:dsh-cua/)
    for (const query of [{guide:cuaTopic},{name:cuaName}]) {
      const response = await fullHelp(call,query)
      assert.match(response,/unavailable/i)
      assert.doesNotMatch(response,/Detached reference/)
    }
  })
}

test('bridge call help describes only direct, admitted batch members and multiline shell calls',async t=>{
  const {ctx,prepare} = await harness(t)
  const removeGlob = ctx.tools.register(tool('glob','List paths'))
  ctx.tools.register(tool('arena_read_batch','Reserved name collision'))
  ctx.tools.register(tool('grep','Search text'),{when:()=>false})
  ctx.tools.register(tool('pwsh','Run a command'))
  const {call} = await prepare()
  const list = await fullHelp(call,{})
  assert.match(list,/arena_read_batch/)
  assert.doesNotMatch(list,/harness-text|"calls"/)
  const batch = await fullHelp(call,{name:'arena_read_batch'})
  assert.match(batch,/calls/)
  assert.match(batch,/\bglob\b/)
  assert.doesNotMatch(batch,/\bgrep\b|Reserved name collision/)
  assert.match(await fullHelp(call,{name:'pwsh'}),/\$text/)
  assert.match(await fullHelp(call,{name:'pwsh'}),/```harness-text script/)
  assert.doesNotMatch(await fullHelp(call,{name:'glob'}),/\$text|harness-text/)
  removeGlob()
  assert.doesNotMatch(await fullHelp(call,{}),/arena_read_batch/)
  assert.match(await fullHelp(call,{name:'arena_read_batch'}),/unavailable/i)
  const program = await harness(t,true)
  program.ctx.tools.register(tool('glob','Program binding'))
  program.ctx.tools.register(tool('pwsh','Program shell binding'))
  const programCall = (await program.prepare()).call
  assert.doesNotMatch(await fullHelp(programCall,{}),/arena_read_batch/)
  assert.match(await fullHelp(programCall,{name:'arena_read_batch'}),/unavailable/i)
  assert.doesNotMatch(await fullHelp(programCall,{name:'pwsh'}),/harness-text/)
})

test('image generation instructions are discoverable as their own bridge topic',async t=>{
  const {ctx,prepare} = await harness(t)
  ctx.tools.register(tool('read','Read a file'))
  const {call} = await prepare()
  assert.match(await fullHelp(call,{}),/bridge:images/)
  assert.doesNotMatch(await fullHelp(call,{name:'read'}),/image generation/)
  assert.match(await fullHelp(call,{guide:'bridge:images'}),/Arena.*image.*final answer/is)
})

test('only help for the admitted skill loader exposes the current skill catalog', async t=>{
  const {createUserMessage} = await import('@deepseek-ai/dsh-llm')
  const {ctx,agent,prepare} = await harness(t,true)
  const removeSkill = ctx.tools.register(tool('skill','Load the named skill'))
  const catalog = entries => agent.session.append('user/message',createUserMessage({
    content:[{type:'text',text:secret}],source:{kind:'skill-catalog',form:'catalog',entries},
  }),{surfaceOp:'append'})
  agent.session.append('turn/start',{turn:1})
  catalog([{name:'obsolete-skill',description:'Retired'}])
  catalog([{name:'active-skill',description:'The latest catalog summary',extra:secret}])
  const {call} = await prepare()
  const tools = await fullHelp(call,{})
  assert.match(tools,/\{name:"skill"\}/)
  assert.doesNotMatch(tools,/active-skill|obsolete-skill|latest catalog summary|UNRELATED_PRIVATE_CONTENT/)
  const details = await fullHelp(call,{name:'skill'})
  assert.match(details,/active-skill/)
  assert.match(details,/latest catalog summary/)
  assert.doesNotMatch(details,/obsolete-skill|UNRELATED_PRIVATE_CONTENT/)
  catalog([])
  assert.doesNotMatch(await fullHelp(call,{name:'skill'}),/active-skill/)
  catalog([{name:'still-journaled',description:'Hidden after restriction'}])
  removeSkill()
  assert.doesNotMatch(await fullHelp(call,{}),/\{name:"skill"\}|still-journaled/)
  assert.doesNotMatch(await fullHelp(call,{name:'skill'}),/still-journaled/)
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
      if (method==='setup') return {supportsOnDemandContext:true,supportsToolHelp:true,supportsResultView:true}
      if (method==='start') {requests.push(request);return {id:request.requestId}}
      if (requests.length===1) {
        const fixture = fileURLToPath(new URL('./first-help-command.py',import.meta.url))
        const python = process.env.ARENA_PYTHON || (process.platform==='win32' ? 'python' : 'python3')
        const example = execFileSync(python,[fixture],{input:JSON.stringify(requests[0]),encoding:'utf8',windowsHide:true})
        return {state:'done',reply:JSON.parse(example)}
      }
      const direct = {kind:'tool',name:'arena_tool_help',arguments:{name:target}}
      const nested = {kind:'tool',name:'run_code',arguments:{description:'Read current documentation',code:
        'const page = await tools.arena_tool_help({name:"future_plugin_v2"}); (typeof inspect === "function" ? inspect : console.log)(page.text)'}}
      return {state:'done',reply:requests.length===2 ? (mode==='native' ? direct : nested) : {kind:'text',text:'Done'}}
    }}
    ctx.llm.registerAdapter(['arena'],new ArenaAdapter(ctx,peer,1))
    const {agent} = await ctx.agents.create({sessionId:'help-'+mode,meta:{cwd:root},agentOptions:selection})
    agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Look up the new tool.'}]}))
    await agent.whenIdle()
    assert.equal(requests.length,3)
    assert.equal(requests[0].toolHelpViaCode===true,mode==='ptc')
    assert.equal(requests[0].tools.some(s=>s.name==='arena_tool_help'),mode==='native')
    const index=JSON.parse(requests[1].toolResult)
    assert.equal(index.failed,false,index.text)
    assert.match(index.text,/future_plugin_v2/)
    assert.doesNotMatch(index.text,/Dynamic reference entry/)
    const result=JSON.parse(requests[2].toolResult)
    assert.equal(result.failed,false,result.text)
    assert.match(result.text,/Dynamic reference entry/)
    assert.match(result.text,/local file/)
    assert.match(result.text,/integer/)
  })
}
