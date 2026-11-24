const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('binding pins the source tab and document, keeps token in worker, and restricts skill choice to popup', async () => {
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
  const context = vm.createContext({ chrome, URL, crypto, AbortSignal, setTimeout, clearTimeout,
    fetch: async (url, opts) => {
      const data = JSON.parse(opts.body);
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
  assert.equal((await send(popup, {type:'bind', tab:7, token:'local-test-token'})).ok, true);
  assert.equal(requests[0].opts.headers.Authorization, 'Bearer local-test-token');
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
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:8766/v1/poll');
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
  assert.equal(requests.at(-1).url, 'http://127.0.0.1:8766/v1/skill');
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
  assert.equal(requests.at(-1).url,'http://127.0.0.1:8766/v1/file-chunk');
  assert.deepEqual(requests.at(-1).data,{chat,binding:'bind1',tab:7,job:'job1',index:0,offset:0});
  loseSentAck = true;
  assert.equal((await send(tab,{...poll,type:'event',event:{id:'sent-original',kind:'sent',job:'job1'}})).ok,false);
  assert.equal((await send(tab,{...poll,type:'depart'})).ok,true);
  const retry = requests.slice(-2).map(r => [r.data.kind,r.data.id]);
  assert.deepEqual(retry[0],['sent','sent-original']);
  assert.equal(retry[1][0],'busy');
  storage.link.lease='stale-offer';
  const beforeRebind=requests.length;
  assert.equal((await send(popup,{type:'bind',tab:7,token:'local-test-token'})).ok,true);
  assert.ok(requests[beforeRebind].url.endsWith('/bind'));
  assert.equal(requests.length,beforeRebind+1,'discard unoffered stale lease without replay');
  lease='still-offered';
  await send(popup,{type:'bind',tab:7,token:'local-test-token'});
  assert.equal(requests.at(-1).data.kind,'uncertain');
  assert.equal(requests.at(-1).data.job,'still-offered');
  storage.link.lease='stale-on-poll';
  await send(tab,poll);
  assert.equal(storage.link.lease,undefined,'terminal resolution clears worker lease');
});

function navigationFixture() {
  const chat='https://arena.ai/agent/one', binding='b1', pageKey='doc1', token='local';
  const browser={id:7,url:chat,status:'complete'}, messages=[], requests=[];
  const doc={chat,binding,pageKey}, sender={id:'ext',frameId:0,tab:{id:7},url:chat};
  const state={link:{chat,binding,pageKey,token,tab:7},active:doc,offer:{id:'image',text:'read_image',png:'AAAA'},lease:null};
  let receive,updated,removed;
  const chrome={
    runtime:{id:'ext',getURL:name=>'chrome-extension://ext/'+name,onMessage:{addListener:fn=>receive=fn}},
    storage:{session:{get:async()=>({link:structuredClone(state.link)}),set:async({link})=>{state.link=structuredClone(link);}}},
    tabs:{get:async()=>structuredClone(browser),query:async()=>[],
      sendMessage:async (id,msg,opts)=>{
        messages.push({id,type:msg.type,frame:opts.frameId});
        if(state.hung) return new Promise(()=>{});
        if(!state.active) throw Error('No receiving document.');
        state.onProof?.();
        return {ok:true,...state.active};
      },
      onUpdated:{addListener:fn=>updated=fn},onRemoved:{addListener:fn=>removed=fn}}
  };
  const ctx=vm.createContext({chrome,URL,crypto,AbortSignal,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(20,ms)),clearTimeout,fetch:async(url,opts)=>{
    const data=JSON.parse(opts.body);requests.push({url,data});
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
  return {browser,doc,sender,state,messages,requests,send,
    update:async(change,id=7)=>{updated(id,change,structuredClone(browser));await settle();},
    close:async()=>{removed(7);await settle();}};
}

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
