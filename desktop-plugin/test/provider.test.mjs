import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { register } from '../../harness-adapter/node_modules/tsx/dist/esm/api/index.mjs'
register({ tsconfig: fileURLToPath(new URL('../../deepseek-harness/tsconfig.json', import.meta.url)) })

const provider = 'arena'
const model = 'agent-mode'
const textBlock = text => ({ type: 'text', text })
const user = (id, text) => ({ id, role: 'user', source: {kind: 'user'}, content: [textBlock(text)] })
const read = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: {type:'string'} } } }
const options = { sessionId: 'desktop-session', provider, model, tools: [read], messages: [user('user-1', 'Read the fixture')] }
const collect = async iterable => Array.fromAsync(iterable)

function toolImageMessages(content) {
  const origin = user('picture','Inspect the screenshot')
  const id = 'arena_'+createHash('sha256').update(JSON.stringify([options.sessionId,origin.id])).digest('hex')
  return [origin,{id:'assistant',role:'assistant',source:{kind:'model',provider,model},
    content:[{type:'tool-call',id,name:'read',arguments:'{}'}]},
    {id:'image-result',role:'tool',toolCallId:id,content}]
}

class BrowserPeer {
  calls = []
  queued = new Map()
  supportsResultView = true
  supportsOnDemandContext = true
  reply = { kind: 'text', text: 'reply from fixture' }
  async rpc(method, params = {}) {
    this.calls.push({ method, params })
    if (method === 'setup') return {supportsPngBatch:true,supportsResultView:this.supportsResultView,
      supportsOnDemandContext:this.supportsOnDemandContext,audioDirectory:this.audioDirectory}
    if (method === 'start') {
      this.queued.set(params.requestId, params)
      return { id: params.requestId }
    }
    if (method === 'status') return this.reply ? { state: 'done', reply: this.reply } : { state: 'waiting' }
    if (method === 'cancel') return { ok: true }
    throw Error('Unexpected ' + method)
  }
}

test('native DSH registry advertises Arena and streams only the newest human action', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Llm } = await import('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  try {
    await ctx.plugin(Llm)
    const peer = new BrowserPeer()
    ctx.llm.registerAdapter([provider], new ArenaAdapter(ctx, peer, 1))
    assert.equal((await ctx.llm.listModels(provider))[0].id, model)
    const messages = [user('old', 'private old history'), {role:'system', content:[textBlock('private system')]}, ...options.messages]
    const chunks = await collect(ctx.llm.stream({ ...options, messages }))
    assert.equal(chunks.find(c => c.type === 'text-delta').text, 'reply from fixture')
    assert.deepEqual(chunks.at(-1).reason, {kind: 'stop'})
    assert.equal(peer.calls.find(c => c.method === 'start').params.text, 'Read the fixture')
    assert.deepEqual(peer.calls.find(c => c.method === 'start').params.tools, [read])
    assert.doesNotMatch(JSON.stringify(peer.calls), /private old history|private system/)
  } finally { await ctx.fiber.dispose() }
})

test('an audio-only reply opens the two original files through durable local Desktop links', async t => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const root = await mkdtemp(join(tmpdir(),'arena audio #'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const peer = new BrowserPeer()
  peer.audioDirectory = join(root,'audio')
  const header = '524946462600000057415645666d74201000000001000100401f0000401f0000010008006461746102000000'
  const files = [Buffer.from(header + '8080','hex'), Buffer.from(header + '00ff','hex')]
  peer.reply = {kind:'text', text:'', audio:files.map(raw => ({mediaType:'audio/wav',data:raw.toString('base64')}))}
  const adapter = new ArenaAdapter({},peer,1)
  const locations = async () => {
    const events = await collect(adapter.stream(options))
    assert.deepEqual(events.at(-1).reason,{kind:'stop'})
    const output = events.filter(event=>event.type==='text-delta').map(event=>event.text).join('\n')
    const links = [...output.matchAll(/\[Audio track (\d+)\]\(<([^>]+)>\)/g)]
    assert.deepEqual(links.map(([,ordinal])=>ordinal),['1','2'])
    return links.map(([, ,address])=>decodeURIComponent(address))
  }
  const paths = await locations()
  assert.deepEqual(await locations(),paths)
  for (const [index,path] of paths.entries()) {
    assert.ok(path.startsWith(peer.audioDirectory.replaceAll('\\','/')+'/'))
    assert.match(path,/\.arena-audio\.wav$/)
    assert.deepEqual(await readFile(path),files[index])
  }
})

test('an unavailable audio directory yields a visible diagnostic and a completed turn', async t => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const root = await mkdtemp(join(tmpdir(),'arena-audio-failure-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const peer = new BrowserPeer()
  peer.audioDirectory = join(root,'cannot-create')
  await writeFile(peer.audioDirectory,'a file in place of the audio directory')
  peer.reply = {kind:'text', text:'Here is the narration.', audio:[{mediaType:'audio/wav',data:Buffer.from(
    '524946462600000057415645666d74201000000001000100401f0000401f00000100080064617461020000008080','hex').toString('base64')}]}
  const events = await collect(new ArenaAdapter({},peer,1).stream(options))
  assert.deepEqual(events.at(-1).reason,{kind:'stop'})
  const output = events.filter(event=>event.type==='text-delta').map(event=>event.text).join('\n')
  assert.match(output,/narration/)
  assert.match(output,/could not save.*audio/i)
  assert.doesNotMatch(output,/\[Audio track/)
})

test('a pending voice playback reports its action once and keeps the original reply stream', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  const rpc = peer.rpc.bind(peer)
  let polls = 0
  peer.rpc = async (method, args) => {
    if (method === 'status' && polls++ < 2) return {state:'waiting',voicePlaybackRequired:true}
    return rpc(method,args)
  }
  const events = await collect(new ArenaAdapter({},peer,1).stream(options))
  const deltas = events.filter(event=>event.type==='text-delta')
  assert.equal(deltas.length,2)
  assert.match(deltas[0].text,/play the chosen voice sample/i)
  assert.equal(deltas[1].text,peer.reply.text)
  assert.deepEqual(deltas.map(({index})=>index),[0,1])
  assert.equal(peer.calls.filter(({method})=>method==='start').length,1)
})

test('ordinary tool calls with overlapping voice prompts do not become bridge audio choices', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const original = options.messages[0]
  const id = 'arena_' + createHash('sha256').update(JSON.stringify([options.sessionId,original.id])).digest('hex')
  const args = {questions:[{id:'regular-question',question:'Pick a voice',options:[{label:'Voice Sample 1'},{label:'Skip'}]}]}
  const similarLinks = '- [Voice Sample 1](</another/arena-0123456789abcdef-1-012345678901234567890123.arena-audio.mp3>)'
  for (const [name,payload] of [
    ['ask_user_question',args],
    ['run_code',{description:'Choose a voice from Arena',code:`await tools.ask_user_question(${JSON.stringify(args)})`}],
  ]) {
    const messages = [original,{id:'assistant',role:'assistant',source:{kind:'model',provider,model},
      content:[textBlock(similarLinks),{type:'tool-call',id,name,arguments:JSON.stringify(payload)}]},
    {id:'normal-result',role:'tool',toolCallId:id,content:[textBlock('Tool result')]}]
    const request = await new ArenaAdapter({},new BrowserPeer(),1).request({...options,messages})
    assert.equal(JSON.parse(request.toolResult).text,'Tool result')
    assert.equal(request.galleryAnswer,undefined)
  }
})

test('an explicit tool action streams its explanation and exactly one executable block', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  peer.reply = {kind:'tool', name:'read', arguments:{file_path:'project.txt'}, text:'Прочитаю первую строку.'}
  const chunks = await collect(new ArenaAdapter({}, peer, 1).stream(options))
  const ended = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(ended.map(chunk => [chunk.index, chunk.block.type]), [[0,'text'],[1,'tool-call']])
  assert.deepEqual(ended[0].block, textBlock(peer.reply.text))
  assert.equal(ended[1].block.name, 'read')
  assert.deepEqual(chunks.at(-1).reason, {kind:'tool-calls'})
})

test('a read batch rejects an unavailable or malformed member before streaming any block', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  const adapter = new ArenaAdapter({}, peer, 1)
  const valid = {name:'read', arguments:{file_path:'one.txt'}}
  for (const invalid of [{name:'pwsh', arguments:{}}, {name:'grep', arguments:{}}, {...valid, arguments:[]}]) {
    peer.reply = {kind:'tool-batch', calls:[valid, invalid], text:'I will inspect both.'}
    await assert.rejects(adapter.stream(options).next(), /batch|tool/i)
  }
  peer.reply = {kind:'tool-batch', calls:[valid, valid], text:'I will inspect both.'}
  const chunks = await collect(adapter.stream(options))
  const tools = chunks.filter(chunk => chunk.block?.type === 'tool-call').map(chunk => chunk.block)
  assert.equal(tools.length, 2)
  assert.notEqual(tools[0].id, tools[1].id)
  assert.deepEqual(chunks.at(-1).reason, {kind:'tool-calls'})
  const assistant = {id:'a', role:'assistant', source:{kind:'model', provider, model}, content:tools}
  const result = (id, index) => ({id, role:'tool', toolCallId:tools[index].id, content:[textBlock(id)]})
  await assert.rejects(adapter.request({...options, messages:[...options.messages, assistant, result('one', 0)]}), /batch/i)
  const request = await adapter.request({...options, messages:[...options.messages, assistant, result('two', 1), result('one', 0)]})
  assert.deepEqual(JSON.parse(request.toolResult).results.map(row => row.text), ['one', 'two'])
  peer.reply.calls = Array(5).fill(valid)
  const largerBatch = await collect(adapter.stream(options))
  assert.equal(largerBatch.filter(chunk => chunk.block?.type === 'tool-call').length, 5)
})

test('one Arena action becomes a stable native DSH tool call and the next request carries its result', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  peer.reply = { kind: 'tool', name: 'read', arguments: { file_path: 'project.txt' } }
  const adapter = new ArenaAdapter({}, peer, 1)
  const first = await collect(adapter.stream(options))
  const repeat = await collect(adapter.stream(options))
  const tool = first.find(c => c.type === 'block-end').block
  assert.equal(tool.type, 'tool-call')
  assert.deepEqual(JSON.parse(tool.arguments), {file_path:'project.txt'})
  assert.deepEqual(first.at(-1).reason, { kind:'tool-calls' })
  assert.equal(repeat.find(c => c.type === 'block-end').block.id, tool.id)
  assert.equal(peer.queued.size, 1)

  const result = { id:'result-1', role:'tool', toolCallId:tool.id, source:{kind:'tool',callId:tool.id}, content:[textBlock('file marker')] }
  const messages = [...options.messages, {id:'model-1', role:'assistant', source:{kind:'model', provider, model}, content:[tool]}, result]
  peer.reply = {kind:'text', text:'finished'}
  await collect(adapter.stream({...options, messages}))
  assert.equal(peer.queued.size, 2)
  assert.match(peer.calls.findLast(c => c.method === 'start').params.toolResult, /file marker/)
  const issued = peer.calls.length
  await assert.rejects(collect(adapter.stream({...options, sessionId:'different-desktop', messages})), /original|session/i)
  const unrelated = [user('different-origin', 'A different user action'), ...messages.slice(1)]
  await assert.rejects(collect(adapter.stream({...options, messages:unrelated})), /original|session/i)
  assert.equal(peer.calls.length, issued)
  peer.reply = {kind:'tool',name:'unregistered',arguments:{}}
  await assert.rejects(collect(adapter.stream({...options, messages:[user('other', 'next')]})), /tool/i)
})

test('PowerShell process status belongs to its exact Harness call and session', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  const tools = [{name:'pwsh'}]
  peer.reply = {kind:'tool', name:'pwsh', arguments:{command:'exit 7'}}
  const adapter = new ArenaAdapter({}, peer, 1)
  const chunks = await collect(adapter.stream({...options,tools}))
  const call = chunks.find(chunk => chunk.block?.type === 'tool-call').block
  const result = {id:'process-result',role:'tool',toolCallId:call.id,content:[textBlock('before\r\n[exit code: 7]')]}
  const messages = [...options.messages,{role:'assistant',source:{provider,model},content:[call]},result]
  const exec = {name:'pwsh',callId:call.id,agent:{session:{id:options.sessionId}}}
  const facts = {exitCode:7,signal:null,timedOut:false}
  const foreground = {isError:false,value:{kind:'foreground',...facts}}
  adapter.recordShellResult({...exec,agent:{session:{id:'different'}}},foreground)
  assert.deepEqual((await adapter.request({...options,tools,messages})).toolResultView,{})
  adapter.recordShellResult(exec,foreground)
  const request = await adapter.request({...options,tools,messages})
  assert.deepEqual(request.toolResultView,{process:facts})
  assert.equal(JSON.parse(request.toolResult).text,result.content[0].text)
  peer.reply = {kind:'text',text:'Done'}
  peer.supportsResultView = false
  await collect(adapter.stream({...options,tools,messages}))
  const legacyRequest = peer.calls.findLast(call => call.method === 'start').params
  assert.equal(legacyRequest.toolResultView,undefined)
  assert.equal(legacyRequest.toolResult,request.toolResult)
})

test('a native image read captions the actual delivered dimensions and preserves the image', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const sharp = createRequire(import.meta.url)('sharp')
  const png = await sharp({create:{width:12,height:8,channels:3,background:'#de262d'}}).png().toBuffer()
  const peer = new BrowserPeer()
  const adapter = new ArenaAdapter({get:() => ({readImage:async () => ({data:png})})},peer,1)
  const tools = [{name:'read_image'}]
  peer.reply = {kind:'tool', name:'read_image', arguments:{file_path:'fixture.png'}}
  const chunks = await collect(adapter.stream({...options,tools}))
  const call = chunks.find(chunk => chunk.block?.type === 'tool-call').block
  const name = 'a'.repeat(119)+'😀'
  const result = {id:'image-result',role:'tool',toolCallId:call.id,content:[textBlock('<path>native metadata</path>'),{
    type:'image',attachment:{id:'img',mediaType:'image/png',bytes:png.length,width:12,height:8,name:name+'.png',
      originalDimensions:{width:24,height:24}},
  }]}
  const messages = [...options.messages,{role:'assistant',source:{provider,model},content:[call]},result]
  const request = await adapter.request({...options,tools,messages})
  assert.equal(request.png,png.toString('base64'))
  assert.deepEqual(request.toolResultView,{image:`${name} (12×8 px, original 24×24 px, coordinates ×2 x / ×3 y)`})
})

test('aborting a pending browser reply cancels the bound request and auxiliary calls send nothing', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  peer.reply = undefined
  const adapter = new ArenaAdapter({}, peer, 2)
  await assert.rejects(collect(adapter.stream({...options, purpose:'session-title'})), /auxiliary/i)
  assert.equal(peer.calls.length, 0)
  const controller = new AbortController()
  const pending = collect(adapter.stream({...options, signal:controller.signal}))
  await new Promise(resolve => setTimeout(resolve, 15))
  controller.abort()
  await assert.rejects(pending, /abort/i)
  const start = peer.calls.find(c => c.method === 'start').params
  assert.deepEqual(peer.calls.find(c => c.method === 'cancel').params, {id:start.requestId,sessionId:options.sessionId})
})

test('transfers bytes of the current native PNG attachment and rejects unsupported or offloaded images', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII=', 'base64')
  const ref = { id:'local-image-object', mediaType:'image/png', bytes:bytes.length, width:2, height:2 }
  const attachment = {type:'image', attachment:ref}
  const store = { async readImage(selected) { assert.deepEqual(selected, ref); return {data:bytes,ref} } }
  const adapter = new ArenaAdapter({ get:key => key === 'attachments' ? store : undefined }, new BrowserPeer())
  const imageRequest = (...content) => adapter.request({...options,messages:toolImageMessages(content)})
  const request = await imageRequest(textBlock('Describe it'), attachment)
  assert.equal(request.png, bytes.toString('base64'))
  assert.equal(JSON.parse(request.toolResult).text, 'Describe it')
  assert.doesNotMatch(JSON.stringify(request), /local-image-object|private-old-file/)
  await assert.rejects(imageRequest({...attachment,offloaded:true}), /PNG/)
  await assert.rejects(imageRequest({...attachment,attachment:{...ref,mediaType:'image/webp'}}), /PNG/)
  const uncached = new ArenaAdapter({get(){throw Error('Unexpected store access')}},new BrowserPeer())
  const rejected = content => uncached.request({...options,messages:toolImageMessages(content)})
  await assert.rejects(uncached.request({...options,messages:[{...user('legacy',''),content:[attachment]}]}),/reattach the original/i)
  await assert.rejects(rejected(Array(21).fill(attachment)), /20/)
  await assert.rejects(rejected([{...attachment,attachment:{...ref,bytes:51*1024**2}}]), /50 MiB/)
  const mislabeled = new ArenaAdapter({get:() => ({readImage:async () => ({data:bytes})})},new BrowserPeer())
  await assert.rejects(mislabeled.request({...options,messages:toolImageMessages([
    {...attachment,attachment:{...ref,mediaType:'image/jpeg'}}
  ])}), /match|format/i)
})

test('one native tool result sends all screenshots in order in one request', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const sharp = createRequire(import.meta.url)('sharp')
  const red = await sharp({create:{width:12,height:4,channels:3,background:'#de262d'}}).png().toBuffer()
  const blue = await sharp({create:{width:3,height:8,channels:3,background:'#1234c9'}}).jpeg().toBuffer()
  const files = { red, blue }
  const blocks = Object.entries(files).map(([id,data]) => ({
    type:'image', attachment:{id,bytes:data.length,mediaType:id === 'red' ? 'image/png' : 'image/jpeg'},
  }))
  const peer = new BrowserPeer()
  const adapter = new ArenaAdapter({ get:() => ({readImage:async ref => ({data:files[ref.id]})}) },peer,1)
  const content = [textBlock('First line'),blocks[1],textBlock('Second line'),blocks[0]]
  const current = user('two-images','Read the images')
  const previous = {...user('previous',''),content:[{type:'file',attachment:{id:'private'}}]}
  peer.reply = {kind:'tool',name:'read',arguments:{file_path:'two.png'}}
  const events = await collect(adapter.stream({...options,messages:[previous,current]}))
  const tool = events.find(e => e.type === 'block-end').block
  const assistant = {id:'assistant',role:'assistant',source:{kind:'model',provider,model},content:[tool]}
  const result = {id:'tool-result',role:'tool',toolCallId:tool.id,content}
  peer.reply = {kind:'text',text:'done'}
  await collect(adapter.stream({...options,messages:[previous,current,assistant,result]}))
  const requests = peer.calls.filter(call => call.method === 'start').map(call => call.params)
  assert.equal(requests.length,2)
  assert.equal(requests[0].text,'Read the images')
  assert.deepEqual(JSON.parse(requests[1].toolResult),{toolCallId:tool.id,failed:false,text:'First line\nSecond line'})
  {
    const request = requests[1]
    assert.equal(request.png,undefined)
    assert.equal(request.pngs.length,2)
    assert.equal(request.pngs[1],red.toString('base64'))
    const first = sharp(Buffer.from(request.pngs[0],'base64'))
    assert.equal((await first.metadata()).format,'png')
    const pixel = await first.removeAlpha().raw().toBuffer()
    assert.ok(pixel[2]>190 && pixel[0]<30)
  }
})

test('a failed, offloaded, cancelled or over-budget member prevents any part of the turn from starting', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const sharp = createRequire(import.meta.url)('sharp')
  const pixels = randomBytes(1120 * 1200 * 3)
  const png = await sharp(pixels,{raw:{width:1120,height:1200,channels:3}}).png().toBuffer()
  assert.ok(png.length <= 4 * 1024 ** 2 && 9 * png.length > 32 * 1024 ** 2)
  const image = {type:'image',attachment:{id:'normal',mediaType:'image/png',bytes:png.length}}
  const peer = new BrowserPeer()
  const controller = new AbortController()
  const adapter = new ArenaAdapter({get:() => ({async readImage(ref) {
    if (ref.id === 'missing') throw Error('fixture read failed')
    if (ref.id === 'aborted') controller.abort()
    return {data:png}
  }})},peer,1)
  const send = (content,signal) => collect(adapter.stream({...options,signal,messages:toolImageMessages(content)}))
  for (const [later,error] of [
    [{...image,offloaded:true},/accessible/i],
    [{...image,attachment:{...image.attachment,mediaType:'image/webp'}},/PNG|JPEG/],
    [{type:'file',attachment:{id:'unrelated'}},/unexpected desktop content/i],
    [{...image,attachment:{...image.attachment,id:'missing'}},/fixture read failed/],
  ]) await assert.rejects(send([image,later]),error)
  await assert.rejects(send(Array(9).fill(image)),/32 MiB/)
  await assert.rejects(send([image,{...image,attachment:{...image.attachment,id:'aborted'}}],controller.signal),/abort/i)
  assert.equal(peer.calls.length,0)
})

test('a previous companion cannot acknowledge a multi-image request as text only', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII=','base64')
  const image = {type:'image',attachment:{id:'example',bytes:data.length,mediaType:'image/png'}}
  const calls = []
  const peer = {async rpc(method) { calls.push(method); return {chat:'example'} }}
  const adapter = new ArenaAdapter({get:()=>({readImage:async()=>({data})})},peer)
  await assert.rejects(collect(adapter.stream({...options,messages:toolImageMessages([image,image])})),/update.*companion/i)
  assert.deepEqual(calls,['setup'])
})

test('DSH tool JPEGs reach the wire as bounded PNGs and named user previews require original file intake', async t => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LocalAttachments } = await import('@deepseek-ai/dsh-attachment-local')
  const sharp = createRequire(new URL('../../harness-adapter/package.json', import.meta.url))('sharp')
  const home = await mkdtemp(join(tmpdir(), 'arena-native-attachment-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  const width = 1600, height = 1200
  const pixels = randomBytes(width * height * 3)
  function patch(x, y, color) {
    for (let dy = 0; dy < 128; dy++) {
      const start = 3 * ((y + dy) * width + x)
      pixels.fill(Buffer.from(color), start, start + 128 * 3)
    }
  }
  patch(0, 0, [240, 20, 30])
  patch(width-128, height-128, [10, 30, 240])
  const source = await sharp(pixels, {raw:{width, height, channels:3}}).png().toBuffer()
  const limit = 4 * 1024 ** 2
  assert.ok(source.length > limit)

  for (const [role, expectedType] of [['tool','image/jpeg'], ['user','image/png']]) {
    await t.test(role + ' ' + expectedType, async () => {
      const ctx = new Context()
      const store = new LocalAttachments(ctx, {dshHome:join(home,role), normalizedImageMaxBytes:role === 'user' ? 8 * 1024 ** 2 : limit})
      const ref = await store.saveImage({data:source,mediaType:'image/png',name:'colors.png'})
      assert.equal(ref.mediaType,expectedType)
      const peer = new BrowserPeer()
      const adapter = new ArenaAdapter({get:key => key === 'attachments' ? store : undefined},peer)
      const content = [textBlock('Inspect the colors'), {type:'image', attachment:ref}]
      let messages
      if (role === 'tool') {
        peer.reply = {kind:'tool',name:'read',arguments:{file_path:'colors.png'}}
        const first = await collect(adapter.stream(options))
        const tool = first.find(event => event.type === 'block-end').block
        messages = [...options.messages, {id:'assistant',role:'assistant',source:{kind:'model',provider,model},content:[tool]},
          {id:'image-result',role:'tool',toolCallId:tool.id,content}]
      } else {
        messages = [{...user('image-user',''),content}]
        await assert.rejects(collect(adapter.stream({...options,messages})),/reattach the original file/i)
        assert.equal(peer.calls.length,0)
        await ctx.fiber.dispose()
        return
      }
      peer.reply = {kind:'text',text:'colors received'}
      await collect(adapter.stream({...options,messages}))
      const request = peer.calls.findLast(call => call.method === 'start').params
      const png = Buffer.from(request.png,'base64')
      assert.ok(png.length <= limit)
      assert.equal((await sharp(png).metadata()).format,'png')
      const {data,info} = await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject:true})
      assert.ok(Math.abs(info.width/info.height-width/height) < 0.01)
      const colorAt = (x,y) => Array.from(data.subarray(3*(y*info.width+x),3*(y*info.width+x)+3))
      const top = colorAt(5,5), bottom = colorAt(info.width-6,info.height-6)
      assert.ok(top[0]>210 && top[2]<60 && bottom[2]>210 && bottom[0]<60)
      assert.equal(JSON.parse(request.toolResult).text,'Inspect the colors')
      assert.equal((await store.readImage(ref)).data.byteLength,ref.bytes)
      await ctx.fiber.dispose()
    })
  }
})

test('JSONL companion death promptly rejects pending requests', async () => {
  const { Companion } = await import('../companion.mjs')
  const child = new Companion({ command:process.execPath, args:['-e', "process.stdin.once('data', () => process.exit(7))"], cwd:process.cwd() })
  try { await assert.rejects(child.rpc('setup'), /companion|bridge/i) }
  finally { await child.close() }
})

test('generated Arena images persist as ordinary assistant attachments and stay out of the next request', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default:Llm, createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { default:LocalAttachments } = await import('@deepseek-ai/dsh-attachment-local')
  const { ArenaAdapter } = await import('../provider.mjs')
  const sharp = createRequire(import.meta.url)('sharp')
  const home = await mkdtemp(join(tmpdir(), 'arena-generated-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Llm)
  for (const name of ['session','session-projection','system-prompt','tools','agent'])
    await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default)
  await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
  await ctx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default, {agents:[]})
  await ctx.plugin(LocalAttachments, {dshHome:home})
  const peer = new BrowserPeer()
  const red = await sharp({create:{width:17,height:9,channels:3,background:'#ef2a30'}}).png().toBuffer()
  const blue = await sharp({create:{width:10,height:12,channels:3,background:'#203bdf'}}).webp({lossless:true}).toBuffer()
  const swatches = [red,blue]
  for (let i=2; i<10; i++) {
    swatches.push(await sharp({create:{width:17,height:9,channels:3,background:{r:i,g:14,b:201}}}).png().toBuffer())
  }
  const images = swatches.map((data,i) => ({mediaType:i===1 ? 'image/webp' : 'image/png',data:data.toString('base64')}))
  peer.reply = {kind:'text',text:'Готово.',images}
  ctx.llm.registerAdapter([provider], new ArenaAdapter(ctx, peer, 1))
  const {agent} = await ctx.agents.create({sessionId:'native-generated-image',agentOptions:{provider,model}})
  const ask = async text => {
    agent.followup(createUserMessage({source:{kind:'user'},content:[textBlock(text)]}))
    await agent.whenIdle()
    return agent.session.deriveMessages().findLast(row => row.role === 'assistant')
  }
  const message = await ask('Generate the swatches')
  assert.deepEqual(message.content.map(block => block.type),['text',...Array(10).fill('image')])
  assert.equal(message.content[0].text,'Готово.')
  const reopened = new LocalAttachments(new Context(), {dshHome:home})
  const expectedColors=[[239,42,48],[32,59,223],...Array.from({length:8},(_,i)=>[i+2,14,201])]
  for (const [index,expected] of expectedColors.entries()) {
    const {data} = await reopened.readImage(message.content[index+1].attachment)
    const pixels = await sharp(data).removeAlpha().raw().toBuffer()
    assert.deepEqual(Array.from(pixels.subarray(0,3)),expected)
  }
  assert.ok(!JSON.stringify(agent.session.snapshotEvents()).includes(images[0].data))
  peer.reply = {kind:'text',text:'',images:[images[0]]}
  const pictureOnly = await ask('Generate one more picture')
  assert.deepEqual(pictureOnly.content.map(block => block.type),['image'])
  const latest = peer.calls.findLast(row => row.method === 'start').params
  assert.equal(latest.text,'Generate one more picture')
  assert.ok(!latest.png && !JSON.stringify(latest).includes(images[0].data))
})

test('invalid or cancelled generated image batches emit no partial answer', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default:LocalAttachments } = await import('@deepseek-ai/dsh-attachment-local')
  const { ArenaAdapter } = await import('../provider.mjs')
  const home = await mkdtemp(join(tmpdir(), 'arena-reject-image-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  const store = new LocalAttachments(new Context(), {dshHome:home})
  const peer = new BrowserPeer()
  const adapter = new ArenaAdapter({get:()=>store},peer,1)
  const good = {mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGPgEtHlEtFlgFAAB7YBLctR6mAAAAAASUVORK5CYII='}
  const large = {mediaType:'image/png',data:Buffer.alloc(4*1024**2+1).toString('base64')}
  for (const images of [[],Array(21).fill(good),[large,large],[good,{...good,data:good.data+'!'}],
    [good,{...good,mediaType:'image/jpeg'}],[good,{mediaType:'image/png',data:'YWJj'}],
    [{mediaType:'image/svg+xml',data:'PHN2Zz4='}],[{mediaType:'image/png',url:'https://outside.invalid/file'}]]) {
    peer.reply = {kind:'text',text:'caption',images}
    await assert.rejects(adapter.stream(options).next())
  }
  peer.reply = {kind:'tool',name:'read',arguments:{file_path:'fixture'},images:[good]}
  await assert.rejects(adapter.stream(options).next())
  peer.reply = {kind:'text',text:'caption',images:[good]}
  const controller = new AbortController()
  const gated = new ArenaAdapter({get:()=>({async admitPromptContent(parts) {
    const result = await store.admitPromptContent(parts)
    controller.abort()
    return result
  }})}, peer, 1)
  await assert.rejects(gated.stream({...options,signal:controller.signal}).next(),/abort/i)
})

test('Connect Arena discloses its pairing credential only to the operator dialog', async () => {
  const { pairingCommand } = await import('../pairing.mjs')
  const calls = []
  const peer = { async rpc(method, params) {
    calls.push({method, params})
    if (params?.sessionId !== options.sessionId) throw Error('Only the original conversation can open this binding')
    return { pairToken:'fixture-private-credential',chat:'https://arena.ai/agent/abc',port:8766 }
  } }
  const command = pairingCommand(peer, async setup => {
    assert.equal(setup.pairToken, 'fixture-private-credential')
    return 'disconnect'
  })
  assert.match(command.description, /Connect Arena/i)
  const invoke = sessionId => command.handler({agent:{session:{id:sessionId},model:{current:()=>({provider,model})}},rawInput:'',signal:new AbortController().signal})
  const result = await invoke(options.sessionId)
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls, ['setup','disconnect'].map(method => ({method,params:{sessionId:options.sessionId}})))
  await assert.rejects(invoke('foreign-session'), /original conversation/)
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-credential/)
})

test('forwards current DSH skill summaries and only the explicit invocation for this user turn', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  const adapter = new ArenaAdapter({}, peer)
  const catalog = entries => ({ role:'user', source:{kind:'skill-catalog', form:'catalog', entries}, content:[textBlock('private catalog markup')] })
  const invoked = text => ({role:'user',source:{kind:'skill-invocation',name:'manual',form:'instructions'}, content:[textBlock(text)]})
  const messages = [user('earlier','previous'), invoked('private previous instructions'),
    catalog([{name:'obsolete',description:'stale'}]), user('human','/manual do it'),
    catalog([{name:'auto',description:'Available model skill',secret:'private directory'}]), invoked('manual instructions for this turn')]
  const nativeSkill = {name:'skill',description:'load instructions',parameters:{type:'object'}}
  await collect(adapter.stream({...options,messages,tools:[read,nativeSkill]}))
  const request = peer.calls.find(c => c.method === 'start').params
  assert.deepEqual(request.skills, [{name:'auto',description:'Available model skill'}])
  assert.match(request.text, /manual instructions for this turn/)
  assert.doesNotMatch(JSON.stringify(request), /private|obsolete|stale/)
  await collect(adapter.stream({...options,messages,tools:[read]}))
  assert.deepEqual(peer.calls.findLast(c => c.method === 'start').params.skills, [])
  await assert.rejects(collect(adapter.stream({...options,messages,purpose:'title'})), /auxiliary/)
})

const cuaSection = 'computer-use:dsh-cua'
const system = (sections, texts, flags = {}) => ({role:'system', source:{kind:'system-prompt', sections, ...flags},
  content:texts.map(textBlock)})
const activeSection = (name, contentIndex) => ({name, state:'active', order:20, contentIndex})
const runCode = {name:'run_code', description:'Run a program', parameters:{type:'object'}}

test('a same-name direct tool is advertised as bridge help only with its scoped help marker', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const adapter = new ArenaAdapter({},new BrowserPeer())
  const named = {...options,tools:[{name:'arena_tool_help',parameters:{type:'object'}}]}
  const messages = [system([activeSection('arena:tool-help',0)],['Arena tool reference is available for this step through arena_tool_help.']),...options.messages]
  assert.equal((await adapter.request(named)).toolHelpDirect,false)
  assert.equal((await adapter.request({...named,messages})).toolHelpDirect,true)
})

test('program routes come from the same live step and the help example follows its runtime', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const marker = 'Arena tool reference is available for this step through arena_tool_help.'
  const messages = [system([activeSection('arena:tool-help',0)], [marker]), ...options.messages]
  const agent = {session:{id:options.sessionId}}
  const signal = new AbortController().signal
  const sections = ['tools:sdk','tools:ptc-only'].map(name=>({name,text:'native program block'}))
  for (const [language, programFormat, expected] of [
    ['typescript','function-body','typescript'], ['typescript','scoped-repl','typescript'],
    ['typescript','repl','typescript'], ['typescript','script','typescript'], ['python','script','python'],
  ]) {
    let capture
    const adapter = new ArenaAdapter({on:(_event,listener)=>{capture=listener},
      get:key=>key==='ptcRuntime'?{language,programFormat}:undefined},new BrowserPeer())
    const current = new Map(['read','arena_tool_help','new_tool'].map(name=>[name,{name}]))
    const toolSet = {view:scope=>scope===agent ? new Map(current) : new Map()}
    const args = {...options,tools:[runCode],messages,signal}
    assert.equal((await adapter.request(args)).programToolRoutes,undefined)
    await capture({sections},{scope:agent,agent,signal,toolSet,modelSelection:{provider,model}},async()=>({sections}))
    const request = await adapter.request(args)
    assert.equal(request.toolHelpViaCode,true)
    assert.equal(request.toolHelpProgram,expected)
    assert.deepEqual(request.programToolRoutes,{language,names:['arena_tool_help','new_tool','read']})
    current.delete('read')
    assert.ok(!(await adapter.request(args)).programToolRoutes.names.includes('read'))
    assert.equal((await adapter.request({...args,sessionId:'different'})).programToolRoutes,undefined)
    assert.equal((await adapter.request({...args,signal:new AbortController().signal})).programToolRoutes,undefined)
    assert.equal((await adapter.request({...args,tools:[read]})).programToolRoutes,undefined)
    assert.equal((await adapter.request({...options,tools:[runCode]})).toolHelpProgram,undefined)
    const exclusive = {sections:[...sections,{name:'exclusive',text:'Custom prompt',complete:true}]}
    await capture(exclusive,{scope:agent,agent,signal,toolSet,modelSelection:{provider,model}},async()=>({sections}))
    assert.equal((await adapter.request(args)).programToolRoutes,undefined)
  }
})

test('ordinary requests and tool continuations do not collect or pass Computer Use instructions', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const guide = 'PRIVATE_NATIVE_GUIDE'
  const legacy = {role:'system',source:{kind:'system-prompt'},content:[textBlock(guide)]}
  const current = system([activeSection(cuaSection,0)], [guide])
  const agent = {session:{id:options.sessionId}}
  const adapter = new ArenaAdapter({agents:{get:()=>agent}, tools:{get:()=>({name:'cua'})},
    get:() => { throw Error('No native guide should be assembled before a help request') }}, new BrowserPeer())
  for (const systemMessage of [legacy, current]) {
    for (const tools of [[runCode], [{name:'cua'}], [{name:'cua_run_code'}], []]) {
      const request = await adapter.request({...options,tools,messages:[systemMessage,...options.messages]})
      assert.equal(Object.hasOwn(request,'computerUseGuidance'),false)
      assert.doesNotMatch(JSON.stringify(request), /PRIVATE_NATIVE_GUIDE/)
    }
  }
  const request = await adapter.request(options)
  const callId = 'arena_' + request.requestId
  const assistant = {role:'assistant',source:{provider,model},content:[{type:'tool-call',id:callId,name:'read',arguments:{}}]}
  const result = {id:'result',role:'tool',toolCallId:callId,content:[textBlock('actual tool output')]}
  const next = await adapter.request({...options,messages:[...options.messages,assistant,result,current]})
  assert.equal(Object.hasOwn(next,'computerUseGuidance'),false)
  assert.match(next.toolResult,/actual tool output/)
})

test('a companion with the old proactive prompt never receives a new turn', async () => {
  const { ArenaAdapter } = await import('../provider.mjs')
  const peer = new BrowserPeer()
  peer.supportsOnDemandContext = false
  const adapter = new ArenaAdapter({},peer)
  for (const tools of [[], [read], [runCode]]) {
    await assert.rejects(collect(adapter.stream({...options,tools})),/update.*companion/i)
  }
  assert.deepEqual(peer.calls.map(c=>c.method),['setup','setup','setup'])
})

test('a real legacy PTC session can expose run_code without attaching its scoped Computer Use guide', async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const { default:SystemPrompt, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { default:Tools } = await import('@deepseek-ai/dsh-tools')
  const { ArenaAdapter } = await import('../provider.mjs')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.setExecutor({describe:() => ({schemas:[runCode]})})
  const agent = {session:{id:options.sessionId}}
  ctx.provide('agents',{get:id => id === agent.session.id ? agent : undefined})
  ctx.provide('sessionProjections',{snapshot:()=>({values:{}})})
  const scope = createScope(ctx,agent)
  const tool = {name:'cua_run_code',description:'Inspect the desktop',parameters:{type:'object'},
    output:{schema:{type:'null'},render:()=>[]},execute:async()=>null}
  const guide = 'Use the cua object inside the dedicated CUA program.'
  await scope.ctx.plugin({name:'test-cua',inject:['tools','systemPrompt'],apply(owner) {
    owner.tools.register(tool)
    owner.systemPrompt.section({name:cuaSection,order:40,text:guide})
  }})
  const selection = {provider,model}
  const snapshot = await ctx.systemPrompt.assemble({scope:agent,agent,modelSelection:selection})
  assert.deepEqual(snapshot.tools.map(t=>t.name),['run_code'])
  assert.equal(ctx.tools.get('cua',agent),undefined)
  assert.equal(ctx.tools.get('cua_run_code',agent),tool)
  const messages=[{role:'system',source:{kind:'system-prompt'},content:[textBlock(renderPrompt(snapshot))]},...options.messages]
  let adapter
  // The production adapter receives a plugin context with tools and agents injected.
  await ctx.plugin({name:'arena-test-provider',inject:['agents','tools','sessionProjections'],apply(pluginCtx) {
    adapter = new ArenaAdapter(pluginCtx,new BrowserPeer())
  }})
  const request = await adapter.request({...options,messages,tools:snapshot.tools})
  assert.equal(Object.hasOwn(request,'computerUseGuidance'),false)
  assert.ok(!JSON.stringify(request).includes(guide))
})

test('native DSH executes two parallel reads before one Arena continuation and preserves edit approval', {timeout:15000}, async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default:Llm, createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { ArenaAdapter } = await import('../provider.mjs')
  const root = await mkdtemp(join(tmpdir(), 'arena-native-session-'))
  t.after(() => rm(root, {recursive:true, force:true}))
  await writeFile(join(root, 'item.txt'), 'before')
  await writeFile(join(root, 'second.txt'), 'second marker')
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Llm)
  for (const name of ['session','session-projection','system-prompt','tools','agent','commands']) {
    await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default)
  }
  await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
  await ctx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default, {agents:[]})
  await ctx.plugin((await import('@deepseek-ai/dsh-user-approval')).default, {policy:'ask'})
  await ctx.plugin((await import('@deepseek-ai/dsh-fs-local')).default, {cwd:root})
  await ctx.plugin((await import('@deepseek-ai/dsh-working-directory')).default)
  await ctx.plugin(await import('@deepseek-ai/dsh-fs-observation-policy'))
  await ctx.plugin(await import('@deepseek-ai/dsh-tool-fs'), {readImage:false,write:false})

  const calls = []
  let pairedSession
  const approvals = []
  const peer = new BrowserPeer()
  peer.rpc = async (method, args) => {
    if (method === 'setup') {
      if (args?.sessionId) pairedSession = args.sessionId
      return { pairToken:'synthetic-integration-token', chat:null, pairingState:'unpaired', port:0, supportsResultView:true, supportsOnDemandContext:true }
    }
    assert.equal(args.sessionId, pairedSession)
    if (method === 'pairStatus') return { state:'paired' }
    if (method === 'start') { calls.push(args); return {id:args.requestId} }
    assert.equal(method, 'status')
    let reply
    if (calls.length === 1) reply = {kind:'tool-batch', calls:['item.txt','second.txt'].map(file_path => ({name:'read', arguments:{file_path}}))}
    if (calls.length === 2) reply = {kind:'tool', name:'edit', arguments:{file_path:'item.txt',old_string:'before',new_string:'after'}}
    if (calls.length === 3) reply = {kind:'text',text:'Finished the native edit'}
    return {state:'done', reply}
  }
  ctx.llm.registerAdapter([provider], new ArenaAdapter(ctx, peer))
  const reads = []
  const bothReading = Promise.withResolvers()
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'edit' ? {kind:'ask',reason:'Review native edit'} : next())
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'read') {
      reads.push(exec.arguments.file_path)
      if (reads.length === 2) bothReading.resolve()
      await Promise.race([bothReading.promise, delay(2000, undefined, {ref:false}).then(() => { throw Error('Reads did not overlap') })])
    }
    return next()
  })
  t.after(() => bothReading.resolve())
  ctx.on('approval/request', req => { approvals.push(req.toolName); return 'allowed-once' })
  const {agent} = await ctx.agents.create({sessionId:'native-file-session',meta:{cwd:root},agentOptions:{provider,model}})
  const { pairingCommand } = await import('../pairing.mjs')
  ctx.commands.register(pairingCommand(peer, async () => 'close'))
  const paired = await ctx.commands.execute(agent, '/arena-pair', [], new AbortController().signal)
  assert.equal(paired.result.kind, 'success')
  assert.equal(pairedSession, agent.session.id)
  assert.doesNotMatch(JSON.stringify(agent.session.snapshotEvents()), /synthetic-integration-token/)
  agent.followup(createUserMessage({source:{kind:'user'},content:[textBlock('Please read and edit the sample')]}))
  await agent.whenIdle()
  assert.equal(calls.length, 3)
  assert.equal(calls[0].text, 'Please read and edit the sample')
  assert.equal(calls[0].supportsReadBatch, true)
  const batch = JSON.parse(calls[1].toolResult).results
  assert.deepEqual(batch.map(row => [row.toolCallId, row.failed]), [0,1].map(index => [`arena_${calls[0].requestId}_${index}`, false]))
  assert.match(batch[0].text, /1: before/)
  assert.match(batch[1].text, /1: second marker/)
  assert.deepEqual([...reads].sort(), ['item.txt','second.txt'])
  assert.match(calls[2].toolResult, /updated successfully/)
  assert.deepEqual(approvals,['edit'])
  assert.equal(await readFile(join(root, 'item.txt'), 'utf8'), 'after')
})
test('arena-reset sends an explicit reset from the current Desktop session', async () => {
  const { resetCommand } = await import('../pairing.mjs')
  const calls = []
  const command = resetCommand({rpc: async (method, params) => {
    calls.push({method, params})
    return {ok:true}
  }})
  const input = {agent:{session:{id:'replacement'}},rawInput:''}
  assert.equal(command.name, 'arena-reset')
  assert.equal((await command.handler({...input,rawInput:'unexpected'})).kind, 'error')
  assert.deepEqual(calls, [])
  const reply = await command.handler(input)
  assert.equal(reply.kind, 'success')
  assert.match(reply.text, /\/arena-pair/)
  assert.deepEqual(calls, [{method:'reset',params:{sessionId:'replacement'}}])
})
