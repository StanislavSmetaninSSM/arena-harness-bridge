const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac, randomBytes } = require('node:crypto');

test('a raw code authenticates port 8766 on each request while pinning the document and restricting skill choice',
  () => exerciseBinding(8766));
test('dynamic binding authenticates the selected loopback companion for each request and receipt retry',
  () => exerciseBinding(59812));

async function exerciseBinding(port) {
  const secret = 'local-test-token';
  const code = port === 8766 ? secret : `AHB1:${port}→${secret}`;
  const base = `http://127.0.0.1:${port}/v1/`;
  const hmac = message => createHmac('sha256', secret).update(message).digest('hex');
  const trace = [];
  const chat = 'https://arena.ai/agent/one';
  const ext = 'chrome-extension://' + 'a'.repeat(32) + '/';
  const storage = {}, requests = [], tabMessages = [];
  const settledDelivery='0123456789abcdef0123456789abcdef';
  let receive, offered, lease=null, loseSentAck = false;
  const watcher = { addListener() {} };
  const chrome = {
    runtime: { id: 'a'.repeat(32), getURL: f => ext + f, onMessage: { addListener: fn => receive = fn } },
    storage: { session: { get: async () => storage, set: async values => Object.assign(storage, values) } },
    tabs: { query: async query => query.url ? [{id:7,url:chat},{id:8,url:'https://arena.ai/agent'}] : [{id:70,url:ext+'popup.html'}], get: async id => ({id,url:chat,status:'complete'}), onUpdated: watcher, onRemoved: watcher,
      sendMessage: async (tab, msg) => {
        tabMessages.push(msg);
        return { ok: true, chat, pageKey:'doc1', draft: 'My task', settledDelivery };
      } }
  };
  const root = path.join(__dirname, '..');
  const context = vm.createContext({ chrome, URL, crypto, TextEncoder, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, opts) => {
      const data = JSON.parse(opts.body);
      const record = {url, opts, data};
      trace.push(record);
      if (url.endsWith('/identity')) {
        // A different instance for each request detects reuse of either the proof or the bearer.
        const instance = randomBytes(16).toString('hex');
        record.instance = instance;
        const proof = hmac(`arena-proof-v1|${port}|${instance}|${data.nonce}`);
        return {ok:true, json:async () => ({instance, proof})};
      }
      requests.push({ url, opts, data });
      if (data.kind === 'sent' || data.kind === 'uncertain') lease=null;
      if (loseSentAck && data.kind === 'sent') { loseSentAck = false; throw Error('connection interrupted after commit'); }
      const job = url.endsWith('/poll') && data.ready ? offered : null;
      if (job) { offered = null; lease=job.id; }
      return { ok:true, json: async () => ({ binding:'bind1', job:job || null, lease,
        recoverTranscript:data.recoverTranscript==='source-changed',
        supportsNativeQuestions:true, context:{id:'ctx',text:'catalogue'}, content:'local instruction', ok:true }) };
    }
  });
  const run = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  context.importScripts = run;
  run('worker.js');
  assert.equal(typeof receive, 'function', 'background message receiver');
  const send = (sender, message) => new Promise(resolve => receive(message, sender, resolve));
  const popup = { id:chrome.runtime.id, url:ext+'popup.html#tab=7' };
  const tab = { id:chrome.runtime.id, frameId:0, tab:{id:7}, url:chat };
  const choices = (await send(popup,{type:'targets'})).targets;
  assert.deepEqual(JSON.parse(JSON.stringify(choices || [])), [{tab:7,chat}]);
  assert.equal((await send(popup, {type:'bind', tab:7, token:code})).ok, true);
  assert.equal(requests[0].data.tab, 7);
  assert.equal(requests[0].data.settledDelivery,settledDelivery);
  assert.equal(tabMessages.find(m=>m.type==='attach').context?.id,'ctx');
  assert.ok(tabMessages.every(m => !JSON.stringify(m).includes('local-test-token')));
  const poll = { type:'poll', chat, binding:'bind1', pageKey:'doc1', ready:true };
  assert.equal((await send({...tab, tab:{id:8}}, poll)).ok, false);
  assert.equal((await send({...tab, frameId:1}, poll)).ok, false);
  assert.equal((await send(tab, {...poll, pageKey:'other'})).ok, false);
  assert.equal((await send({...tab,url:'https://arena.ai/agent/other'},poll)).ok, false);
  assert.equal((await send(tab,{...poll,type:'skill',name:'private'})).ok, false);
  assert.equal(requests.length, 1);
  const probe={...poll,recoverTranscript:'source-changed'};
  assert.equal((await send({...tab,tab:{id:8}},probe)).ok,false);
  assert.equal((await send(tab,{...probe,pageKey:'new-document'})).ok,false);
  assert.equal((await send(tab,{...probe,nativeQuestionId:'old-card'})).recoverTranscript,true);
  assert.deepEqual(requests.at(-1).data,{binding:'bind1',chat,tab:7,ready:false,recoverTranscript:'source-changed'});
  await send(tab,{...poll,type:'event',event:{id:'source-changed',kind:'blocked',transcriptChanged:true,text:'Changed'}});
  assert.equal(requests.at(-1).data.transcriptChanged,true);
  assert.equal((await send(tab,poll)).context?.id, 'ctx');
  assert.equal(requests.at(-1).url, base + 'poll');
  assert.notEqual(requests.at(-1).data.supportsPngBatch, true, 'a stale content script cannot lease a batch');
  await send(tab,{...poll,supportsPngBatch:true});
  assert.equal(requests.at(-1).data.supportsPngBatch,true,'the current content script can lease a batch');
  assert.notEqual(requests.at(-1).data.supportsFiles,true,'stale tabs cannot lease original files');
  await send(tab,{...poll,supportsFiles:true});
  assert.equal(requests.at(-1).data.supportsFiles,true);
  const card={id:'chat-message-card',question:'Which color?',options:['Amber','Indigo']};
  const native=await send(tab,{...poll,ready:false,supportsNativeQuestions:true,nativeQuestionId:card.id});
  assert.equal(native.supportsNativeQuestions,true);
  assert.equal(requests.at(-1).data.nativeQuestionId,card.id);
  let event={id:'widget',kind:'assistant',nativeQuestion:card,replyTo:'job',text:'Question'};
  assert.equal((await send(tab,{...poll,type:'event',supportsNativeQuestions:true,event})).ok,true);
  assert.deepEqual(requests.at(-1).data.nativeQuestion,card);
  assert.equal(requests.at(-1).data.supportsNativeQuestions,true);
  for(const bad of [{...event,replyTo:''},{...event,toolFrame:true},{...event,nativeQuestion:{...card,command:'run'}}])
    assert.equal((await send(tab,{...poll,type:'event',supportsNativeQuestions:true,event:bad})).ok,false);
  await send(tab,{...poll,type:'event',event:{id:'a1',kind:'assistant',text:'frame',toolFrame:true}});
  assert.equal(requests.at(-1).data.toolFrame,undefined);
  const delivery='0123456789abcdef0123456789abcdef';
  await send(tab,{...poll,type:'event',event:{id:'a2',kind:'assistant',text:'frame',toolFrame:true,replyTo:delivery}});
  assert.equal(requests.at(-1).data.toolFrame,true);
  assert.equal(requests.at(-1).data.replyTo,delivery);
  const toolSource=JSON.stringify({$harness:'tool_call',turn_id:delivery,name:'read',arguments:{filePath:'C:/fixture.txt'}});
  const copied={id:'copied',kind:'assistant',text:'I will read it',toolFrame:true,replyTo:delivery,toolSource};
  assert.equal((await send(tab,{...poll,type:'event',recoveredTranscript:'source-changed',event:copied})).ok,true);
  assert.equal(requests.at(-1).data.toolSource,toolSource);
  assert.equal(requests.at(-1).data.text,'I will read it');
  assert.equal(requests.at(-1).data.recoveredTranscript,'source-changed');
  assert.equal((await send(tab,{...poll,type:'event',event:{...copied,toolFrame:false}})).ok,false);
  const images=[{mediaType:'image/webp',data:'aW1hZ2U='}];
  await send(tab,{...poll,type:'event',event:{id:'pic',kind:'assistant',text:'',images,replyTo:'submitted-id'}});
  assert.deepEqual(requests.at(-1).data.images,images);
  assert.equal(requests.at(-1).data.replyTo,'submitted-id');
  const batch=Array.from({length:10},(_,i)=>({mediaType:'image/png',data:Buffer.from([i]).toString('base64')}));
  assert.equal((await send(tab,{...poll,type:'event',event:{id:'batch',kind:'assistant',text:'Done.',images:batch,replyTo:delivery}})).ok,true);
  assert.deepEqual(requests.at(-1).data.images,batch);
  assert.equal(requests.at(-1).data.text,'Done.');
  const beforeInvalid=requests.length;
  for(const images of [Array(21).fill({mediaType:'image/png',data:'AAAA'}),[{mediaType:'image/svg+xml',data:'AAAA'}],
    [{mediaType:'image/png',data:'https://host/image.png'}],[{mediaType:'image/png',data:'A'.repeat(4*Math.ceil((8*1024**2+1)/3))}]]) {
    assert.equal((await send(tab,{...poll,type:'event',event:{id:'invalid-pic',kind:'assistant',text:'',images,replyTo:'submitted-id'}})).ok,false);
  }
  assert.equal(requests.length,beforeInvalid);
  await send(tab,{...poll,type:'event',event:{id:'not-pic',kind:'user',text:'hi',images}});
  assert.equal(requests.at(-1).data.images,undefined);
  await send(tab,{...poll,type:'event',event:{id:'u1',kind:'user',text:'catalogue and draft',contextId:'ctx'}});
  assert.equal(requests.at(-1).data.contextId,'ctx');
  assert.equal((await send(popup,{type:'skill',tab:7,name:'sample'})).ok, true);
  assert.equal(requests.at(-1).url, base + 'skill');
  assert.equal(requests.at(-1).data.name, 'sample');
  assert.ok(tabMessages.some(m => m.type === 'applySkill' && m.content === 'local instruction'));
  offered = {id:'job1',text:'hello'};
  assert.equal((await send(tab,poll)).job.id,'job1');
  const fileChunk={...poll,type:'fileChunk',job:'job1',index:0,offset:0};
  const readsBefore=requests.length;
  for(const changes of [{job:'other'},{index:-1},{offset:1.1},{binding:'other'},{pageKey:'old'}])
    assert.equal((await send(tab,{...fileChunk,...changes})).ok,false);
  assert.equal(requests.length,readsBefore);
  assert.equal((await send(tab,fileChunk)).ok,true);
  assert.equal(requests.at(-1).url,base + 'file-chunk');
  assert.deepEqual(requests.at(-1).data,{chat,binding:'bind1',tab:7,job:'job1',index:0,offset:0});
  loseSentAck = true;
  assert.equal((await send(tab,{...poll,type:'event',event:{id:'sent-original',kind:'sent',job:'job1'}})).ok,false);
  assert.equal((await send(tab,{...poll,type:'depart'})).ok,true);
  const retry = requests.slice(-2).map(r => [r.data.kind,r.data.id]);
  assert.deepEqual(retry[0],['sent','sent-original']);
  assert.equal(retry[1][0],'busy');
  storage.link.lease='stale-offer';
  const beforeRebind=requests.length;
  assert.equal((await send(popup,{type:'bind',tab:7,token:code})).ok,true);
  assert.ok(requests[beforeRebind].url.endsWith('/bind'));
  assert.equal(requests.length,beforeRebind+1,'discard unoffered stale lease without replay');
  lease='still-offered';
  await send(popup,{type:'bind',tab:7,token:code});
  assert.equal(requests.at(-1).data.kind,'uncertain');
  assert.equal(requests.at(-1).data.job,'still-offered');
  storage.link.lease='stale-on-poll';
  await send(tab,poll);
  assert.equal(storage.link.lease,undefined,'terminal resolution clears worker lease');
  assert.ok(tabMessages.every(message => !JSON.stringify(message).includes(secret)));
  const nonces = new Set();
  assert.equal(trace.length, 2 * requests.length);
  for (let index = 0; index < trace.length; index += 2) {
    const [identity, application] = trace.slice(index, index + 2);
    assert.equal(identity.url, base + 'identity');
    assert.equal(identity.opts.method, 'POST');
    assert.deepEqual(Object.keys(identity.data), ['nonce']);
    assert.match(identity.data.nonce, /^[0-9a-f]{32}$/);
    assert.equal(nonces.has(identity.data.nonce), false);
    nonces.add(identity.data.nonce);
    assert.equal(new Headers(identity.opts.headers).has('Authorization'), false);
    assert.equal(identity.opts.cache, 'no-store');
    assert.equal(identity.opts.redirect, 'error');
    assert.equal(application.opts.redirect, 'error');
    assert.ok(application.url.startsWith(base));
    const bearer = hmac(`arena-auth-v1|${port}|${identity.instance}`);
    assert.equal(application.opts.headers.Authorization, 'Bearer ' + bearer);
    assert.ok(!JSON.stringify(tabMessages).includes(bearer));
    assert.ok(!JSON.stringify([identity, application]).includes(secret));
  }
}

function navigationFixture(transport) {
  const chat='https://arena.ai/agent/one', binding='b1', pageKey='doc1', token='local';
  const browser={id:7,url:chat,status:'complete'}, messages=[], requests=[], wire=[];
  const doc={chat,binding,pageKey}, sender={id:'ext',frameId:0,tab:{id:7},url:chat};
  const state={link:{chat,binding,pageKey,token,tab:7},active:doc,offer:{id:'image',text:'read_image',png:'AAAA'},lease:null};
  let receive,updated,removed;
  const chrome={
    runtime:{id:'ext',getURL:name=>'chrome-extension://ext/'+name,onMessage:{addListener:fn=>receive=fn}},
    storage:{session:{get:async()=>({link:structuredClone(state.link)}),set:async({link})=>{state.link=structuredClone(link);}}},
    tabs:{get:async()=>structuredClone(browser),query:async()=>[],
      sendMessage:async (id,msg,opts)=>{
        messages.push({id,type:msg.type,frame:opts.frameId});
        if(state.content) return state.content(msg);
        if(state.hung) return new Promise(()=>{});
        if(!state.active) throw Error('No receiving document.');
        state.onProof?.();
        return {ok:true,...state.active};
      },
      onUpdated:{addListener:fn=>updated=fn},onRemoved:{addListener:fn=>removed=fn}}
  };
  const ctx=vm.createContext({chrome,URL,crypto,TextEncoder,AbortSignal,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(20,ms)),clearTimeout,fetch:async(url,opts)=>{
    const data=JSON.parse(opts.body);
    wire.push({url,data,opts});
    if (transport) return transport(data);
    if (url === 'http://127.0.0.1:8766/v1/identity') {
      const instance = randomBytes(16).toString('hex');
      const proof = createHmac('sha256', token).update(`arena-proof-v1|8766|${instance}|${data.nonce}`).digest('hex');
      return {ok:true, json:async () => ({instance, proof})};
    }
    requests.push({url,data,opts});
    let job=null;
    if(url.endsWith('/poll') && data.ready && state.offer) {
      job=state.offer;state.offer=null;state.lease=job.id;
    }
    if(data.kind==='sent' || data.kind==='uncertain') state.lease=null;
    if(data.kind==='sent' && state.loseAck) {state.loseAck=false;throw Error('Lost acknowledgement');}
    return {ok:true,json:async()=>({ok:true,job,lease:state.lease})};
  }});
  const run=file=>vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  ctx.importScripts=run;run('worker.js');
  const send=(msg,from=sender)=>new Promise(resolve=>receive({...doc,...msg},from,resolve));
  const settle=()=>send({type:'targets'},{id:'ext',url:chrome.runtime.getURL('popup.html')});
  return {browser,doc,sender,state,messages,requests,wire,send,
    update:async(change,id=7)=>{updated(id,change,structuredClone(browser));await settle();},
    close:async()=>{removed(7);await settle();}};
}

function routeFixture() {
  const f=navigationFixture(), original=[{siteId:'u1',role:'user',text:'Old question'},
    {siteId:'a1',role:'assistant',text:'Old answer',complete:true}];
  const foreign='https://arena.ai/agent/two', root='https://arena.ai/agent';
  let rows=structuredClone(original), tick, listen, mutation, first=true;
  let rowsReadWhileAway=0, draft='', now=1000;
  const submissions=[], handlers={}, field={};
  const ctx=vm.createContext({location:{href:f.doc.chat},URL,Date:class extends Date{static now(){return now;}},
    crypto:{randomUUID:()=>first?(first=false,f.doc.pageKey):crypto.randomUUID()},
    document:{documentElement:{}},addEventListener:(name,fn)=>{handlers[name]=fn;},
    MutationObserver:class{constructor(fn){mutation=fn;}observe(){}},setInterval:fn=>{tick=fn;},setTimeout,clearTimeout,
    chrome:{runtime:{id:'ext',sendMessage:msg=>f.send(msg),onMessage:{addListener:fn=>{listen=fn;}}}},
    ArenaPage:class{
      rowIds(){return rows.map(row=>row.siteId);}
      rows(){if(ctx.location.href!==f.doc.chat || rows.some(row=>row.siteId==='b')) rowsReadWhileAway++;return rows.map(row=>({...row}));}
      captureReplySource(row){if(row.stream){row.sourceOrigin='stream';return row.stream;}}
      historyReplySource(row,origin){return origin==='stream' ? row.stream ?? {status:'unobserved'} : row.copy;}
      state(){return {field,idle:true,ready:!draft,value:draft};}
      async submit(job,_draft,guard,beforeClick){assert.ok(guard());beforeClick();submissions.push(job.id);
        rows.push({role:'user',siteId:'u-'+job.id,text:job.text,lastLine:job.text.split('\n').at(-1)});
      }
    }
  });
  for (const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  f.state.content=msg=>new Promise(resolve=>listen(msg,{id:'ext'},resolve));
  f.state.offer=null;
  const start=async()=>{
    assert.equal((await f.state.content({type:'prepare',chat:f.doc.chat})).ok,true);
    assert.equal((await f.state.content({type:'attach',...f.doc})).ok,true);
    await tick();
  };
  const travel=async(url,history,contentFirst=false)=>{
    ctx.location.href=url; f.browser.url=url;rows=history;
    if(contentFirst){mutation();await tick();}
    await f.update({url});
    mutation();await tick();
  };
  return {...f,root,foreign,original,start,tick,travel,submissions,getForeignReads:()=>rowsReadWhileAway,
    rows:()=>structuredClone(rows),append:row=>rows.push(row),advance:ms=>{now+=ms;},
    setDraft:value=>{draft=value;},setRows:value=>{rows=value;},handlers};
}

const imageBase='https://arena.ai/files/19a9a4ae-44cd-4310-a12c-ced3a25d9e95.png';
test('a completed live turn survives loss of its stream cache across routes and its follow-up sends once',async()=>{
  const f=routeFixture();await f.start();
  const first='1'.repeat(32), second='2'.repeat(32);
  f.state.offer={id:first,text:'Reply with the test code'};await f.tick();await f.tick();
  f.append({siteId:'chat-message-response',role:'assistant',nativeMessage:true,complete:true,
    text:'СВЯЗЬ-54',stream:'СВЯЗЬ-54',copy:'СВЯЗЬ-54'});
  await f.tick();f.advance(1200);await f.tick();await f.tick();
  assert.equal(f.requests.filter(r=>r.data.kind==='assistant' && r.data.replyTo===first).length,1);
  const restored=f.rows();delete restored.at(-1).stream;
  await f.travel(f.root,[]);await f.travel(f.foreign,[]);
  f.state.offer={id:second,text:'Follow-up'};
  await f.travel(f.doc.chat,restored);
  await f.tick();f.advance(1000);await f.tick();await f.tick();
  assert.deepEqual(f.submissions,[first,second]);
  assert.equal(f.requests.filter(r=>r.data.kind==='sent' && r.data.job===second).length,1);
});

test('image changed after the return proof but before the handshake completes cannot release a queued message',async()=>{
  const f=routeFixture(), original=structuredClone(f.original);
  original[1].artifact={pending:false,sources:[imageBase]};
  f.setRows(original);await f.start();await f.travel(f.foreign,[]);
  f.state.offer={id:'held',text:'Do not send'};
  const content=f.state.content;let changed=false;
  f.state.content=async message=>{
    const reply=await content(message);
    if (message.type==='verifyReturn' && reply.returned) {
      changed=true;
      const replacement=structuredClone(original);
      replacement[1].artifact.sources=['https://arena.ai/files/changed.png'];
      f.setRows(replacement);
    }
    return reply;
  };
  await f.travel(f.doc.chat,original);await f.tick();await f.tick();
  assert.equal(changed,true);
  assert.deepEqual(f.submissions,[]);
  assert.equal(f.state.offer.id,'held');
  const popup=await content({type:'status',pageKey:f.doc.pageKey});
  assert.match(popup.status,/Bind this conversation again/);
});

for(const [kind,allowed] of [['same graphic',true],['new signature on same S3 object',true],['different graphic',false],
  ['different proxy image query',false],['changed native answer',false],['changed image selection',false]]){
  test('return verifies visual or card identity: '+kind,async()=>{
    const f=routeFixture(), history=structuredClone(f.original), row=history.at(-1);
    if(kind==='changed native answer')
      row.nativeQuestion={id:'a1',status:'answered',question:'Choose?',options:['A','B'],selected:'A'};
    else if(kind==='changed image selection')
      row.imageChoices=[{id:'a1/choice',status:'selected',sources:[imageBase]}];
    else row.artifact={pending:false,sources:[kind==='different proxy image query'?'https://arena.ai/proxy?file=1':
      kind==='new signature on same S3 object'?imageBase+'?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc':imageBase]};
    f.setRows(history);await f.start();await f.travel(f.foreign,[]);
    const restored=structuredClone(history), last=restored.at(-1);
    if(kind==='different graphic') last.artifact.sources=['https://arena.ai/files/replacement.png'];
    if(kind==='different proxy image query') last.artifact.sources=['https://arena.ai/proxy?file=2'];
    if(kind==='new signature on same S3 object') last.artifact.sources=[imageBase+'?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=updated'];
    if(kind==='changed native answer') last.nativeQuestion.selected='B';
    if(kind==='changed image selection') last.imageChoices[0].sources=['https://arena.ai/files/other.png'];
    f.state.offer={id:'next',text:'Next'};await f.travel(f.doc.chat,restored);await f.tick();await f.tick();
    assert.deepEqual(f.submissions,allowed?['next']:[]);
  });
}

test('an acknowledged fallback tool command prevents an idle return until its result arrives',async()=>{
  const f=routeFixture();await f.start();
  const id='a'.repeat(32);
  f.state.offer={id,text:'one'};await f.tick();await f.tick();
  f.append({role:'assistant',siteId:'fallback',text:'issued',complete:true,toolFrame:true});
  await f.tick();await f.tick();
  assert.ok(f.requests.some(r=>r.data.toolFrame===true));
  const original=f.rows();
  await f.travel(f.foreign,[]);await f.travel(f.doc.chat,original);
  assert.ok(f.state.link.paused,'Desktop may still be executing the acknowledged command');
});

test('idle original document returns through Arena hub and another conversation, then accepts one queued Desktop input',async()=>{
  const f=routeFixture();await f.start();
  const foreignRows=[{siteId:'b',role:'assistant',text:'FOREIGN',complete:true}];
  await f.travel(f.root,[]);
  await f.travel(f.foreign,foreignRows,true);
  f.state.offer={id:'q1',text:'First after returning'};
  assert.equal(f.getForeignReads(),0);
  await f.travel(f.doc.chat,foreignRows);
  assert.equal(f.submissions.length,0,'wait for the original rows to mount');
  f.setRows(structuredClone(f.original));f.setDraft('User draft');await f.tick();
  assert.equal(f.submissions.length,0,'preserve an unsent browser draft');
  f.setDraft('');await f.tick();await f.tick();await f.tick();
  assert.deepEqual(f.submissions,['q1']);
  assert.equal(f.requests.filter(r=>r.data.kind==='sent').length,1);
  assert.equal(f.getForeignReads(),0,'even after the URL returns, never scrape the other chat');
  assert.ok(f.requests.every(r=>!JSON.stringify(r.data).includes('FOREIGN')));
});

for(const obstacle of ['waiting for an answer','original history edited','document replaced','different tab']){
  test('return cannot deliver a new Desktop input with '+obstacle,async()=>{
    const f=routeFixture();await f.start();
    if(obstacle==='waiting for an answer'){
      f.state.offer={id:'active',text:'Original message'};await f.tick();await f.tick();
      assert.equal(f.state.lease,null,'sent receipt reached Desktop, Arena still owes a reply');
    }
    await f.travel(f.foreign,[],true);
    f.state.offer={id:'new',text:'Never deliver'};
    const restored=structuredClone(f.original);
    if(obstacle==='original history edited') restored[1].text='Different original';
    if(obstacle==='document replaced'){
      const content=f.state.content;f.state.content=msg=>msg.type==='status'?content(msg):{ok:true,...f.doc,pageKey:'other'};
    }
    if(obstacle==='different tab'){
      const count=f.requests.length;
      assert.equal((await f.send({type:'return'}, {...f.sender,tab:{id:8}})).ok,false);
      assert.equal(f.requests.length,count);
    }else{
      await f.travel(f.doc.chat,restored);await f.tick();await f.tick();
    }
    assert.equal(f.submissions.includes('new'),false);
    assert.equal(f.state.offer.id,'new','the offer stays on the companion');
  });
}

test('malformed pairing codes cannot send requests or replace the saved binding', async () => {
  const f = navigationFixture();
  const popup = {id:'ext', url:'chrome-extension://ext/popup.html'};
  const codes = [
    'AHB1:0→secret', 'AHB1:65536→secret', 'AHB1:08765→secret', 'AHB1:8766→secret',
    'AHB1:1e4→secret', 'AHB1:+12345→secret', 'AHB1:12345->secret',
    'AHB1:12345→', 'AHB2:12345→secret', 'AHB1:127.0.0.2:80→secret',
    'http://127.0.0.1:12345', 'https://example.org/', 'AHB1:12345→first→second',
    'AHB1|12345|secret', 'AHB1:12345→first|second'
  ];
  for (const token of codes) {
    assert.equal((await f.send({type:'bind', tab:7, token}, popup)).ok, false);
    assert.equal(f.wire.length, 0, token);
  }
  assert.equal(f.state.link.token, 'local');
});

test('a resumed link sends only a fresh challenge and provides recovery steps for an unknown listener', async () => {
  const secret = 'persistent-test-token';
  for (const failure of ['wrong key', 'old nonce', 'wrong port', 'bad instance', 'uppercase proof', 'HTTP error', 'connection refused']) {
    // Include both boundaries of the syntactically valid port range.
    const port = failure === 'wrong key' ? 1 : 65535;
    const f = navigationFixture(({nonce}) => {
      if (failure === 'connection refused') throw TypeError('Failed to fetch');
      const instance = failure === 'bad instance' ? 'broken' : 'ab'.repeat(16);
      const key = failure === 'wrong key' ? 'another-listener' : secret;
      const proof = createHmac('sha256', key)
        .update(`arena-proof-v1|${failure === 'wrong port' ? 22 : port}|${instance}|${failure === 'old nonce' ? 'old' : nonce}`)
        .digest('hex');
      return {ok:failure !== 'HTTP error', json:async () => ({instance, proof: failure === 'uppercase proof' ? proof.toUpperCase() : proof})};
    });
    f.state.link.token = `AHB1:${port}→${secret}`;
    const result = await f.send({type:'event', event:{id:'message', kind:'user', text:'private draft'}});
    assert.equal(result.ok, false, failure);
    assert.match(result.error, /\/arena-pair.*bind/i);
    assert.equal(f.wire.length, 1);
    assert.equal(f.wire[0].url, `http://127.0.0.1:${port}/v1/identity`);
    assert.equal(new Headers(f.wire[0].opts.headers).has('Authorization'), false);
    assert.deepEqual(Object.keys(f.wire[0].data), ['nonce']);
    assert.doesNotMatch(JSON.stringify(f.wire), /persistent-test-token|private draft/);
  }
});

test('a saved raw token sends only a challenge to a replacement or older listener on port 8766', async () => {
  for (const oldServer of [false, true]) {
    const f = navigationFixture(() => ({
      ok:!oldServer, status:oldServer ? 404 : 200,
      json:async () => ({instance:'aa'.repeat(16), proof:'bb'.repeat(32)})
    }));
    f.state.link.token = 'old-persistent-token';
    const result = await f.send({type:'event', event:{id:'draft', kind:'user', text:'private message'}});
    assert.equal(result.ok, false);
    assert.equal(f.wire.length, 1);
    const [challenge] = f.wire;
    assert.equal(challenge.url, 'http://127.0.0.1:8766/v1/identity');
    assert.deepEqual(Object.keys(challenge.data), ['nonce']);
    assert.match(challenge.data.nonce, /^[0-9a-f]{32}$/);
    assert.equal(new Headers(challenge.opts.headers).has('Authorization'), false);
    assert.doesNotMatch(JSON.stringify(f.wire), /old-persistent-token|private message/);
    assert.match(result.error, /update.*extension/i);
    assert.match(result.error, /\/arena-pair.*terminal.*bind/i);
  }
});

test('a stale same-origin sender URL accepts one delivery after the active document proves the binding',async()=>{
  const f=navigationFixture(),poll={type:'poll',ready:true};
  const from={...f.sender,url:'https://arena.ai/agent/previous',documentLifecycle:'active'};
  assert.equal((await f.send(poll,from)).job?.id,'image');
  assert.deepEqual(f.messages,[{type:'verifyDocument',id:7,frame:0}]);
  assert.equal((await f.send(poll,from)).job,null);
  const sent={type:'event',event:{id:'sent-once',job:'image',kind:'sent'}};
  assert.equal((await f.send(sent,from)).ok,true);
  assert.equal(f.state.link.paused,undefined);
  assert.deepEqual(f.requests.filter(r=>r.data.kind).map(r=>r.data.id),['sent-once']);
});

test('a stale sender URL cannot pass without same-origin and current-document proof',async()=>{
  const f=navigationFixture(),poll={type:'poll',ready:true};
  const prior={...f.sender,url:'https://arena.ai/agent/previous'};
  assert.equal((await f.send(poll,{...prior,url:'https://unrelated.example/agent/one'})).ok,false);
  assert.equal(f.messages.length,0,'a different origin is rejected before probing the tab');
  f.state.active={...f.doc,pageKey:'replacement'};
  assert.equal((await f.send(poll,prior)).ok,false);
  assert.equal(f.state.link.paused,undefined,'inconsistent sender metadata alone cannot permanently pause the link');
  f.state.active=f.doc;
  f.browser.pendingUrl='https://arena.ai/agent/another';
  assert.equal((await f.send(poll,prior)).ok,false);
  assert.equal(f.requests.length,0);
  delete f.browser.pendingUrl;
  f.browser.url='https://arena.ai/agent/another';
  assert.equal((await f.send(poll,prior)).ok,false);
  assert.ok(f.state.link.paused,'a committed different chat does pause the link');
  assert.ok(f.requests.every(r=>!r.url.endsWith('/poll')));
});

test('loading that begins during stale-sender verification holds the delivery',async()=>{
  const f=navigationFixture(),poll={type:'poll',ready:true};
  const prior={...f.sender,url:'https://arena.ai/agent/previous'};
  f.state.onProof=()=>{f.browser.status='loading';};
  assert.equal((await f.send(poll,prior)).ok,false);
  assert.equal(f.requests.length,0);
  delete f.state.onProof;
  f.browser.status='complete';
  assert.equal((await f.send(poll,prior)).job?.id,'image');
});

test('a PNG upload loading the same live top document preserves an existing receipt',async()=>{
  const f=navigationFixture(), poll={type:'poll',ready:true};
  const event={type:'event',event:{id:'sent-once',job:'image',kind:'sent'}};
  assert.equal((await f.send(poll)).job.id,'image');
  f.state.loseAck=true;
  assert.equal((await f.send(event)).ok,false);
  const receipt=structuredClone(f.state.link.receipt), count=f.requests.length;
  f.browser.status='loading';await f.update({status:'loading'});
  assert.equal(f.state.link.paused,undefined);
  assert.equal(f.state.link.lease,'image');assert.deepEqual(f.state.link.receipt,receipt);
  assert.equal(f.requests.length,count,'tab event never publishes or retries a receipt');
  assert.deepEqual(f.messages.at(-1),{type:'verifyDocument',id:7,frame:0});
  f.browser.status='complete';await f.update({status:'complete'});
  assert.equal(f.messages.length,2,'recheck the final active top frame');
  assert.equal((await f.send(event)).ok,true);
  assert.deepEqual(f.requests.filter(r=>r.data.id).map(r=>r.data.id),['sent-once','sent-once']);
  assert.equal((await f.send(poll)).job,null);
});

test('temporary loss of frame proof and explicit pending URL hold polls and events without losing the offered delivery',async()=>{
  const f=navigationFixture(), poll={type:'poll',ready:true}, sent={type:'event',event:{id:'original',job:'image',kind:'sent'}};
  await f.send(poll);const count=f.requests.length;
  f.browser.status='loading';f.state.active=null;await f.update({status:'loading'});
  assert.equal(f.state.link.paused,undefined);
  assert.equal((await f.send(poll)).ok,false);assert.equal((await f.send(sent)).ok,false);
  f.state.active=f.doc;f.browser.pendingUrl=f.browser.url;
  assert.equal((await f.send(sent)).ok,false);
  assert.equal(f.requests.length,count);assert.equal(f.state.link.lease,'image');
  delete f.browser.pendingUrl;
  assert.equal((await f.send(sent)).ok,true);
  f.browser.status='complete';await f.update({status:'complete'});
  assert.equal(f.state.link.paused,undefined);
  assert.deepEqual(f.requests.filter(r=>r.data.kind).map(r=>r.data.id),['original']);
});

test('a pending URL seen before the loading notification prevents the first issue',async()=>{
  const f=navigationFixture(),poll={type:'poll',ready:true};
  f.browser.pendingUrl=f.browser.url;
  assert.equal((await f.send(poll)).ok,false);assert.equal(f.requests.length,0);
  delete f.browser.pendingUrl;
  assert.equal((await f.send(poll)).job.id,'image');
});

test('a hung frame cannot lock the worker queue and prevent a real tab close',async()=>{
  const f=navigationFixture();await f.send({type:'poll',ready:true});
  f.browser.status='loading';f.state.hung=true;
  const done=await Promise.race([f.update({status:'loading'}).then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),350))]);
  assert.equal(done,true,'frame verification must give the worker queue back');
  assert.equal(f.state.link.paused,undefined);assert.equal(f.state.link.lease,'image');
  await f.close();
  assert.deepEqual(f.requests.filter(r=>r.data.kind).map(r=>r.data.kind),['uncertain']);
});

test('ignore unrelated tabs and stale navigation snapshots when current Chrome state confirms the new binding',async()=>{
  const f=navigationFixture();
  await f.update({status:'loading'},8);
  assert.equal(f.messages.length,0);
  Object.assign(f.state.link,{pageKey:'rebound-doc',binding:'b2'});
  f.state.active={...f.doc,pageKey:'rebound-doc',binding:'b2'};
  await f.update({url:'https://arena.ai/agent/stale',status:'loading'});
  assert.equal(f.state.link.paused,undefined);
  assert.equal((await f.send({type:'poll',ready:true})).ok,false,'old content is denied');
  assert.equal((await f.send({type:'poll',ready:true,...f.state.active})).job.id,'image');
  assert.equal(f.requests.length,1);
});

for (const change of ['reloaded','missing document','other conversation','closed']) {
  test(change+' after a confirmed loading event stops the original lease exactly once',async()=>{
    const f=navigationFixture(),poll={type:'poll',ready:true};
    await f.send(poll);
    f.browser.status='loading';await f.update({status:'loading'});
    assert.equal(f.state.link.paused,undefined);
    if(change==='closed') await f.close();
    else {
      if(change==='reloaded') f.state.active={...f.doc,pageKey:'replacement'};
      if(change==='missing document') f.state.active=null;
      if(change==='other conversation') f.browser.url='https://arena.ai/agent/two';
      f.browser.status='complete';await f.update(change==='other conversation'?{url:f.browser.url}:{status:'complete'});
    }
    assert.ok(f.state.link.paused);assert.equal(f.state.link.lease,undefined);
    assert.equal((await f.send(poll)).ok,false);
    await f.update({status:'complete'});await f.close();
    assert.deepEqual(f.requests.filter(r=>r.data.kind).map(r=>[r.data.kind,r.data.job]),[['uncertain','image']]);
  });
}
