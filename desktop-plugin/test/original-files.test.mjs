import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { register } from '../../harness-adapter/node_modules/tsx/dist/esm/api/index.mjs'
register({tsconfig:fileURLToPath(new URL('../../deepseek-harness/tsconfig.json',import.meta.url))})

const file = (name, data) => ({type:'file',attachment:{name, bytes:data.length,
  attachmentId:'sha256:'+createHash('sha256').update(data).digest('hex')}})
const text = text => ({type:'text',text})
const user = content => ({role:'user',id:'picked',source:{kind:'user'},content})
const fixtures = [
  ['кадр.gif',Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAIfkEAQAAAAAsAAAAAAEAAQAAAgJEAQA7','base64')],
  ['без расширения',Buffer.from([0,255,17,0])], ['без расширения',Buffer.alloc(0)], ['large.custom',Buffer.alloc(524410,131)],
]

test('only current structured Desktop file occurrences stage their verbatim bytes in user order',async()=>{
  const {ArenaAdapter}=await import('../provider.mjs')
  const inputs=fixtures.map(([name,raw])=>file(name,raw))
  const handle=ref=>'text handle for '+ref.attachmentId
  const content=[text('Task'),...inputs,text(handle(inputs[0].attachment))]
  const raw=user(content)
  const projected=user(content.map(b=>b.type==='file'?text(handle(b.attachment)):b))
  const messages=[projected]
  const rpc=[],chunks=new Map()
  const agent={session:{deriveMessages:()=>[{...user([file('private',Buffer.from('earlier'))]),id:'earlier'},raw]}}
  const ctx={agents:{get:()=>agent},llm:{fileRequestText:handle},get:()=>({
    async *readFileStream(ref) {yield fixtures.find(([name,bytes])=>name===ref.name&&bytes.length===ref.bytes)[1]}
  })}
  const peer={async rpc(method,p) {rpc.push([method,p]); if(method==='setup')return {supportsOnDemandContext:true,supportsFiles:true}
    if(method==='stageFileChunk'){const bytes=Buffer.from(p.data,'base64');assert.ok(bytes.length<=262144)
      const arr=chunks.get(p.sha256)??[];assert.equal(p.offset,Buffer.concat(arr).length);arr.push(bytes);chunks.set(p.sha256,arr)
      return {nextOffset:p.offset+bytes.length}}
    if(method==='start')return {id:p.requestId}
    if(method==='status')return {state:'done',reply:{kind:'text',text:'Received'}}
    return {}
  }}
  const options={provider:'arena',model:'agent-mode',sessionId:'session',tools:[],messages}
  await Array.fromAsync(new ArenaAdapter(ctx,peer,1).stream(options))
  const request=rpc.find(([method])=>method==='start')[1]
  assert.deepEqual(request.files?.map(x=>x.name),fixtures.map(f=>f[0]))
  assert.equal(request.files[0].mediaType,'image/gif')
  for(const [i,item] of request.files.entries())assert.deepEqual(Buffer.concat(chunks.get(item.sha256)),fixtures[i][1])
  assert.equal(request.text,'Task\n'+handle(inputs[0].attachment))
})

test('installed package declares a browser client to preserve a File before image normalization',async()=>{
  const root=new URL('../',import.meta.url)
  const manifest=JSON.parse(await readFile(new URL('package.json',root)))
  assert.equal(manifest.dsh.client?.platform,'web')
  const source=await readFile(new URL(manifest.exports['./client'],root),'utf8')
  let module
  runInNewContext(source,{window:{__ModuleLoader__:{load:definition=>{module=definition}}}})
  assert.equal(module.id,manifest.name)
  assert.equal(typeof module.factory(()=>({})).apply,'function')
})

test('chunk boundaries survive fragmentation and a repeated occurrence uploads bytes once per staging attempt',async()=>{
  const {stageFiles,fileMetadata} = await import('../original-files.mjs')
  const bytes = fixtures.at(-1)[1]
  const metadata = fileMetadata(file('long.ft',bytes).attachment)
  const request = {sessionId:'session',requestId:'request',files:[metadata,{...metadata,name:'copy.ft'}]}
  async function stage(fragment) {
    const receipt = []
    await stageFiles({async rpc(method,p) {
      assert.equal(method,'stageFileChunk')
      assert.equal(p.sessionId,request.sessionId)
      assert.equal(p.requestId,request.requestId)
      receipt.push([p.offset,p.data])
      return {nextOffset:p.offset + Buffer.byteLength(p.data,'base64')}
    }},{async *readFileStream() {
      for (let pos=0;pos<bytes.length;pos+=fragment) yield bytes.subarray(pos,pos+fragment)
    }},request)
    return receipt
  }
  const first = await stage(300019)
  assert.deepEqual(first.map(([offset,data])=>[offset,Buffer.byteLength(data,'base64')]),
    [[0,262144],[262144,262144],[524288,bytes.length-524288]])
  assert.deepEqual(await stage(6723),first)
})

test('the original request stays unsent and staging is cancelled if admission, the source or its receipt fails',async()=>{
  const {ArenaAdapter}=await import('../provider.mjs')
  const ref=file('report',Buffer.from('abc'))
  const raw=user([ref])
  const agent={session:{deriveMessages:()=>[raw]}}
  const options={provider:'arena',model:'agent-mode',sessionId:'session',tools:[],messages:[user([text('receipt')])]}
  for(const failure of ['unsupported','source','receipt','abort','projection','offloaded']) {
    const calls=[]
    const controller=new AbortController()
    const ctx={agents:{get:()=>agent},llm:{fileRequestText:()=>failure==='projection'?'changed':'receipt'},get:()=>({
      async *readFileStream() {
        if (failure==='source') throw Error('could not read test data')
        yield Buffer.from('abc')
      }
    })}
    const peer={async rpc(method,p) {
      calls.push(method)
      if(method==='setup')return {supportsOnDemandContext:true,supportsFiles:failure!=='unsupported'}
      if(method==='stageFileChunk') {
        if(failure==='abort') controller.abort()
        return {nextOffset:failure==='receipt'?1:p.size}
      }
      if(method==='cancel') return {}
      assert.fail('Unexpected '+method)
    }}
    const messages=failure==='offloaded'?[user([{...text('receipt'),offloaded:true}])]:options.messages
    const invoke=Array.fromAsync(new ArenaAdapter(ctx,peer,1).stream({...options,messages,signal:controller.signal}))
    await assert.rejects(invoke,/update the arena bridge|test data|confirm the file chunk|abort|no longer available/i)
    assert.ok(!calls.includes('start'),failure)
    assert.equal(calls.filter(method=>method==='cancel').length,['source','receipt','abort'].includes(failure)?1:0)
  }
})

test('a filename shortened by Desktop still reaches Arena exactly, without metadata bytes',async()=>{
  const {stageFiles,fileMetadata}=await import('../original-files.mjs')
  const id='d36a9d71-203e-4bd5-a55e-4b58e5d6a388'
  const raw=Buffer.from([0,255,44,12,0,0]), name=' '+('я'.repeat(128))+'.gif'
  const header=Buffer.from(JSON.stringify({id,name,mediaType:'image/gif'}))
  const stored=Buffer.concat([header,raw])
  const ref=file('arena-file-'+id+'-'+header.length+'.bin',stored).attachment
  const stage=async(bytes)=>{
    const itsRef=file(ref.name,bytes).attachment
    const request={requestId:'test',sessionId:'mine',files:[fileMetadata(itsRef)]}
    const chunks=[]
    await stageFiles({async rpc(method,data){
      assert.equal(method,'stageFileChunk');chunks.push(Buffer.from(data.data,'base64'))
      return {nextOffset:data.offset+chunks.at(-1).length}
    }},{async *readFileStream(input){assert.deepEqual(input,itsRef)
      for(let i=0;i<bytes.length;i+=7)yield bytes.subarray(i,i+7)
    }},request)
    return {bytes:Buffer.concat(chunks),metadata:request.files[0]}
  }
  const out=await stage(stored)
  assert.deepEqual(out.bytes,raw)
  assert.deepEqual(out.metadata,{name,mediaType:'image/gif',size:raw.length,sha256:createHash('sha256').update(raw).digest('hex')})
  const ordinary=await stage(raw)
  assert.equal(ordinary.metadata.name,ref.name)
  assert.deepEqual(ordinary.bytes,raw)
})
