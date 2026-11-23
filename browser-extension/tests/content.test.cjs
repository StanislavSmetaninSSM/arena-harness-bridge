const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('paired page consumes one job, posts its echo and final exactly once, and stops after navigation', async () => {
  const chat = 'https://arena.ai/agent/one';
  const rows = [{role:'user',text:'past'}, {role:'assistant',text:'past answer',complete:true}];
  const events = [], polls = [], submissions = [], manualSends = [], handlers = {};
  let listener, tick, job = {id:'q1',text:'hello'}, loseResponse = true, issue, now=100000, released=false;
  const field={contains:()=>false}, button={contains:()=>false};
  const rpc = async m => {
    if(released) throw Error('Old binding has been released');
    if (m.type === 'event') {
      events.push(m.event);
      if (m.event.kind === 'sent' && loseResponse) { loseResponse = false; throw Error('offline'); }
    }
    if (m.type === 'poll') {
      polls.push({ready:m.ready,supportsPngBatch:m.supportsPngBatch});
      if (m.ready && job) { const offer = job; job = null; return {ok:true,job:offer}; }
    }
    return {ok:true};
  };
  const doc = {documentElement:{},addEventListener(){}};
  const ctx = vm.createContext({ document:doc, location:{href:chat}, crypto, URL, Date:class extends Date{static now(){return now;}},
    MutationObserver:class{observe(){}}, addEventListener(type,fn){handlers[type]=fn;},
    setInterval: fn => {tick=fn;}, setTimeout, clearTimeout,
    chrome:{runtime:{id:'test',sendMessage:rpc,onMessage:{addListener:fn=>listener=fn}}},
    ArenaPage:class {
      state() {return {ready:!issue,idle:true,value:'',generating:false,field,button,issue};}
      rows() {return rows.slice();}
      async submit(task, draft, guard, beforeClick) {
        assert.ok(guard());
        if(task.id==='q1') for(const event of [
          {type:'keydown',key:'Enter',target:field},{type:'click',button:0,target:button}
        ]) {
          let stopped=false;
          handlers[event.type]({...event,isTrusted:true,preventDefault(){stopped=true;},stopImmediatePropagation(){}});
          if(!stopped) manualSends.push(event.type);
        }
        beforeClick(); submissions.push(task.text);
        rows.push({role:'user',siteId:'chat-message-'+task.id,text:task.text,lastLine:task.text.split('\n').at(-1)});
        if(task.id==='q1') rows.push({role:'assistant',text:'hello back',complete:true});
      }
    }
  });
  for (const file of ['core.js','content.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  assert.equal(typeof listener,'function','content message receiver');
  const send = msg => new Promise(resolve => listener(msg,{id:'test'},resolve));
  const prepared = await send({type:'prepare',chat});
  assert.equal(prepared.ok,true);
  assert.equal((await send({type:'attach',chat,pageKey:prepared.pageKey,binding:'b1'})).ok,true);
  const verify={type:'verifyDocument',chat,pageKey:prepared.pageKey,binding:'b1'};
  assert.deepEqual({...await send(verify)},{ok:true,chat,pageKey:prepared.pageKey,binding:'b1'});
  for (const bad of [{binding:'old'},{pageKey:'new-tab'},{chat:'https://arena.ai/agent/two'}])
    assert.equal((await send({...verify,...bad})).ok,false);
  for(let i=0;i<6;i++) await tick();
  assert.equal(submissions.length,1);
  assert.match(submissions[0],/^hello\n\nBridge delivery [a-f0-9]{32}$/);
  assert.deepEqual(manualSends,[],'trusted Enter and Send cannot race an in-flight bridge upload even without a catalogue');
  const confirmations = events.filter(e=>e.kind==='sent');
  assert.equal(confirmations.length,2);
  assert.equal(confirmations[0].id,confirmations[1].id);
  assert.equal(events.filter(e=>e.kind==='user').length,0);
  assert.deepEqual(events.filter(e=>e.kind==='assistant').map(e=>e.text),['hello back']);
  assert.ok(polls.some(poll=>!poll.ready),'a completed turn cannot offer another job until the composer settles');
  assert.ok(polls.every(poll=>poll.supportsPngBatch===true),'only the updated content script advertises batch submission');
  now+=1000; job={id:'q2',text:'second'};
  await tick(); await tick();
  assert.ok(events.some(e=>e.kind==='sent'&&e.job==='q2'));
  issue={kind:'limited',text:'Daily limit reached.'};
  await tick();
  assert.deepEqual(events.filter(e=>e.kind==='limited').map(e=>e.job),['q2'],'quota after visible echo retains job ID');
  issue=null; job={id:'q3',text:'must wait for operator'};
  const onLimit=polls.length;
  await tick(); await tick();
  assert.equal(polls.length,onLimit,'quota clearance alone must not resume');
  const replay=await send({type:'prepare',chat});
  await send({type:'attach',chat,pageKey:replay.pageKey,binding:'b2',reset:true});
  issue={kind:'limited',text:'Limit on old binding'};released=true;
  await tick();issue=null;
  const reconnect=await send({type:'prepare',chat});
  assert.equal(reconnect.ok,true,'explicit rebind can validate the terminal even with an unacknowledged stale outbox');
  await send({type:'attach',chat,pageKey:reconnect.pageKey,binding:'b3',reset:true});released=false;
  handlers.pagehide({isTrusted:false});
  assert.equal((await send({...verify,binding:'b3'})).ok,true);
  handlers.pagehide({isTrusted:true});
  assert.equal((await send({...verify,binding:'b3'})).ok,false,'a departed document cannot prove ownership after a same-URL reload');
  ctx.location.href = 'https://arena.ai/agent/other';
  const prior = polls.length;
  await tick();
  assert.equal(polls.length,prior);
});

const shotJob='dad0beef0123456789abcdef01234567';
for (const [mode,marked] of [['redraw',true],['edit',true],['edit',false]]) {
  test(`acknowledged echo ${mode} before ${marked ? 'command' : 'final'} publication`,async()=>{
    const chat='https://arena.ai/agent/echo', rows=[{role:'assistant',siteId:'old',text:'Previous reply',complete:true}];
    const events=[];
    let control,tick,mutate,source,now=100000,offer=true;
    const ctx=vm.createContext({location:{href:chat},crypto,URL,document:{documentElement:{}},addEventListener(){},
      Date:class extends Date{static now(){return now;}},
      MutationObserver:class{constructor(fn){mutate=fn;}observe(){}},setInterval:fn=>{tick=fn;},
      ArenaPage:class {
        rows(){return rows.map(row=>({...row}));}
        state(){return {idle:true,ready:true,field:{},value:''};}
        historyReplySource(row){if(row.role==='user')return source;}
        async submit(job,draft,guard,beforeClick){
          assert.ok(guard());beforeClick();
          source=job.text;
          rows.push({role:'user',nativeMessage:true,siteId:'chat-message-echo',text:source,lastLine:source.split('\n').at(-1)});
        }
      },
      chrome:{runtime:{id:'test',onMessage:{addListener:fn=>{control=fn;}},sendMessage:async message=>{
        if(message.type==='event')events.push(message.event);
        if(message.type==='poll' && message.ready && offer){
          offer=false;return {ok:true,job:{id:shotJob,text:'Code\n\tstep()'}};
        }
        return {ok:true};
      }}}
    });
    for (const file of ['core.js','content.js'])
      vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
    const send=message=>new Promise(resolve=>control(message,{id:'test'},resolve));
    const prepared=await send({type:'prepare',chat});
    assert.ok(prepared.ok,prepared.error);
    await send({type:'attach',chat,pageKey:prepared.pageKey,binding:'b1'});
    await tick();await tick();
    assert.equal(events.filter(e=>e.kind==='sent').length,1);
    if (mode==='redraw') rows.at(-1).text=source.replace('\tstep()','step()\t');
    else source=source.replace('\tstep()','\t\tstep()');
    rows.push({role:'assistant',siteId:'chat-message-next',nativeMessage:true,complete:true,text:'Verified reply',toolFrame:marked});
    mutate();now+=1200;await tick();await tick();await tick();
    const replies=events.filter(e=>e.kind==='assistant');
    if (mode==='redraw') {
      assert.deepEqual(replies.map(e=>[e.replyTo,e.toolFrame]),[[shotJob,true]]);
      assert.ok(!events.some(e=>e.kind==='blocked'));
    } else {
      assert.equal(replies.length,0);
      assert.match(events.find(e=>e.kind==='blocked')?.text,/row 2 \(original source\)/);
      assert.equal(events.find(e=>e.kind==='blocked').transcriptChanged,true);
    }
    assert.equal(events.filter(e=>e.kind==='sent').length,1);
  });
}

test('composer account limit preserves a confirmed response and then prevents another Send',async()=>{
  const chat='https://arena.ai/agent/quota', rows=[{role:'assistant',siteId:'old',text:'Previous reply',complete:true}];
  const issues={kind:'limited',text:'Daily usage limit reached',account:true};
  const events=[];
  let receive,tick,account=null,offer=true,submissions=0,draft;
  const ctx=vm.createContext({location:{href:chat},crypto,URL,document:{documentElement:{}},addEventListener(){},
    MutationObserver:class{observe(){}},setInterval:fn=>{tick=fn;},
    ArenaPage:class{
      rows(){return rows.map(r=>({...r}));}
      state(){return {field:{},value:'',ready:!account,issue:account};}
      async submit(job,_,guard,beforeClick){
        assert.ok(guard());beforeClick();draft=job;submissions++;
      }
    },
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>receive=fn},sendMessage:async msg=>{
      if(msg.type==='event') events.push(msg.event);
      if(msg.type==='poll' && msg.ready && offer){offer=false;return {ok:true,job:{id:shotJob,text:'Read the fixture'}};}
      return {ok:true};
    }}}
  });
  for(const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
  const control=msg=>new Promise(resolve=>receive(msg,{id:'test'},resolve));
  const prep=await control({type:'prepare',chat});
  assert.equal((await control({type:'attach',chat,pageKey:prep.pageKey,binding:'b1'})).ok,true);
  await tick();
  account=issues;
  rows.push({role:'user',siteId:'user',text:draft.text,lastLine:draft.receipt});
  await tick();
  assert.equal(events.find(e=>e.kind==='sent')?.job,shotJob);
  rows.push({role:'assistant',siteId:'final',text:'Here is the result.',complete:true});
  await tick();await tick();
  assert.deepEqual(events.filter(e=>['sent','assistant','limited'].includes(e.kind)).map(e=>e.kind),
    ['sent','assistant','limited']);
  assert.equal(submissions,1);
  assert.equal((await control({type:'prepare',chat})).ok,true,'pairing for status works while quota is exhausted');
});

test('native feedback waits for transcript readiness and never repeats a clicked Send', async () => {
  const chat='https://arena.ai/agent/review';
  const history=[{role:'user',text:'hello',siteId:'u1'},
    {role:'assistant',text:'old answer',siteId:'a1',complete:true}];
  let control, tick, now=1000, review=true, continued=0, sent=0, preservedDraft='';
  const events=[];
  const context=vm.createContext({location:{href:chat},crypto,URL,
    Date:class extends Date {static now(){return now;}},
    document:{documentElement:{}},addEventListener(){},
    MutationObserver:class{observe(){}},setInterval:fn=>{tick=fn;},
    chrome:{runtime:{id:'test',onMessage:{addListener:fn=>control=fn},sendMessage:async msg=>{
      if (msg.type==='event') events.push(msg.event);
      if (msg.type==='poll' && msg.ready) return {ok:true,job:{id:shotJob,text:'next task'}};
      return {ok:true};
    }}},
    ArenaPage:class{
      rows(){return history.map(row=>({...row}));}
      state(){return {field:{},ready:!review&&!preservedDraft,idle:!review,review,value:preservedDraft};}
      continueWork(){continued++;review=false;return true;}
      async submit(job,draft,guard,beforeClick,retained,recover){
        assert.ok(guard() && recover && retained===null);
        beforeClick();sent++;review=true;preservedDraft=job.text;
      }
    }
  });
  for (const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  const send=msg=>new Promise(resolve=>control(msg,{id:'test'},resolve));
  const prepared=await send({type:'prepare',chat});
  await send({type:'attach',chat,pageKey:prepared.pageKey,binding:'b1'});
  await tick();await tick();
  assert.equal(continued,1,'dismiss the panel even before another job is queued');
  assert.equal(sent,1);
  await tick();now+=16000;await tick();
  assert.equal(continued,1,'initial Send is still awaiting its echo');
  assert.equal(sent,1);
  assert.ok(events.some(event=>event.kind==='uncertain' && event.job===shotJob));
  assert.match(events.find(event=>event.kind==='uncertain').text,/kept the draft/i);
  assert.match(preservedDraft,/^next task\n\nBridge delivery /);
});

for (const outcome of ['source proof during HTTP acknowledgement','source proof after redraw','source proof changed before click','settles','timed out','another row follows','history edited','prefix restored','permanent edit','permanent replacement','departed during redraw','quota during redraw','edited before publication','superseded before publication','superseded after failed RPC','superseded after lost ack','duplicate ID before publication','edited after lost ack','mixed reply settles','mixed reply times out','mixed reply changes during prepare','acknowledged command redraw','acknowledged command redraw with explicit ID','acknowledged command redraw during RPC','acknowledged command text edited during RPC','acknowledged command text restored','unpublished native command redraw','unpublished native command redraw with changed text','unpublished native command redraw times out','verification restores history','verification leaves missing history','verification changes identity','verification navigation','verification before receipt','verification restores pending command']) {
  test('after sent, desktop screenshot reply '+outcome, async () => {
    const chat='https://arena.ai/agent/screenshot';
    const rows=[{role:'user',text:'earlier',siteId:'old-user'},
      {role:'assistant',text:'earlier answer',siteId:'old-answer',complete:true}];
    const events=[], polls=[], committed=new Map(), field={};
    let control, tick, mutation, now=1000, generating=false, offered=false, issue, editDuringPrepare=false, continuation;
    let pollsBeforeEdit, verification=false, departed=false, deferredEcho;
    let copiedMarkdown='Exact **native** source',sourceReads=0;
    let recoverQueued=false, draftValue='', recoveryReview=false, reviewContinued=0;
    const recoveryPolls=[];
    const ctx=vm.createContext({location:{href:chat},crypto,URL,
      Date:class extends Date {static now(){return now;}},
      document:{documentElement:{}},addEventListener(){},
      MutationObserver:class{constructor(fn){mutation=fn;}observe(){}},
      setInterval:fn=>{tick=fn;},setTimeout:fn=>{if(editDuringPrepare)rows.at(-1).text+=' changed';fn();},
      chrome:{runtime:{id:'test',onMessage:{addListener:fn=>control=fn},sendMessage:async msg=>{
        if(msg.type==='event') {
          events.push(JSON.parse(JSON.stringify(msg.event)));
          const firstAnswer=msg.event.kind==='assistant' && events.filter(e=>e.kind==='assistant').length===1;
          if(outcome==='superseded after failed RPC' && firstAnswer) throw Error('offline before commit');
          if (!committed.has(msg.event.id)) committed.set(msg.event.id,JSON.parse(JSON.stringify(msg.event)));
          if (firstAnswer && outcome==='source proof during HTTP acknowledgement') {
            rows.at(-1).text='Exact\n\nnative source';mutation();
          }
          if (firstAnswer && outcome.startsWith('acknowledged command') && outcome.endsWith('during RPC')) {
            if (outcome.includes('text edited')) {
              pollsBeforeEdit=polls.length;
              rows.at(-1).text += ' edited';
            } else rows.at(-1).toolFrame = false;
            mutation();
          }
          if(outcome==='superseded after lost ack' && firstAnswer) throw Error('offline after commit');
          if(outcome==='edited after lost ack' && msg.event.kind==='assistant' &&
              events.filter(e=>e.kind==='assistant').length===1) throw Error('reply lost after commit');
        }
        if(msg.type==='depart') departed=true;
        if(msg.type==='poll' && msg.recoverTranscript) {
          assert.equal(msg.ready,false);
          recoveryPolls.push(msg.recoverTranscript);
          return {ok:true,recoverTranscript:recoverQueued};
        }
        if(msg.type==='poll') polls.push(msg.ready);
        if(msg.type==='poll' && msg.ready && !offered) {
          offered=true;return {ok:true,job:{id:shotJob,text:'tool returned screenshot',png:'png'}};
        }
        if(msg.type==='poll' && msg.ready && continuation) {
          const job=continuation;continuation=null;return {ok:true,job};
        }
        return {ok:true};
      }}},
      ArenaPage:class{
        rows(){return rows.map(row=>({...row}));}
        captureReplySource(){if(outcome.startsWith('source proof')) return copiedMarkdown;}
        historyReplySource(){sourceReads++;return copiedMarkdown;}
        state(){return {field,idle:!generating&&!verification&&!recoveryReview,
          ready:!generating&&!verification&&!draftValue&&!recoveryReview,
          generating,verification,value:draftValue,issue,review:recoveryReview,reviewAction:recoveryReview};}
        continueWork(){assert.ok(recoverQueued);reviewContinued++;recoveryReview=false;return true;}
        async submit(job,draft,guard,click){
          assert.ok(guard());
          if (job.id!==shotJob && outcome==='source proof changed before click') copiedMarkdown+=' edited';
          if(!guard(true))throw Error('Conversation changed before Send.');
          click();
          const echo={role:'user',text:job.text,lastLine:job.text.split('\n').at(-1),
            siteId:job.id===shotJob ? 'chat-message-echo' : 'chat-message-continuation',nativeMessage:true};
          if (outcome==='verification before receipt') {
            deferredEcho=echo;
            verification=true;
          } else rows.push(echo);
        }
      }
    });
    for(const file of ['core.js','content.js'])
      vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
    const send=msg=>new Promise(resolve=>control(msg,{id:'test'},resolve));
    const prepared=await send({type:'prepare',chat});
    await send({type:'attach',chat,pageKey:prepared.pageKey,binding:'b1'});
    await tick();await tick();
    if (outcome==='verification before receipt') {
      assert.equal(events.some(e=>e.kind==='sent'),false);
      now+=60000;await tick();
      verification=false;mutation();await tick();
      assert.equal(events.some(e=>['blocked','uncertain'].includes(e.kind)),false,'verification time does not expire the receipt timer');
      rows.push(deferredEcho);mutation();await tick();await tick();
      assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),[shotJob]);
      return;
    }
    assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),[shotJob]);
    if (outcome.startsWith('source proof')) {
      const reply={role:'assistant',siteId:'chat-message-result',nativeMessage:true,complete:true,text:'Exact native source'};
      rows.push(reply);mutation();now+=1200;await tick();await tick();
      assert.equal(events.filter(e=>e.kind==='assistant').length,1);
      assert.equal(JSON.stringify(events).includes('**native**'),false,'historical raw never enters the broker wire');
      if (outcome.endsWith('redraw')) {
        reply.text='Exact\n\nnative source';mutation();now+=11000;await tick();
        const reads=sourceReads;await tick();await tick();
        assert.equal(sourceReads,reads,'settled rendering does not cause repeated Copy');
      }
      const next='beef1234567890abcdef123456789012';
      continuation={id:next,text:'Continue now'};now+=1100;await tick();await tick();await tick();
      const sent=events.filter(e=>e.kind==='sent').map(e=>e.job);
      if (outcome.endsWith('click')) {
        assert.deepEqual(sent,[shotJob]);
        const fault=events.find(e=>e.kind==='blocked');
        assert.match(fault?.text,/original source/);
        assert.equal(fault.transcriptChanged,true);
        const probes=recoveryPolls.length;
        verification=true;
        await tick();
        assert.match(events.at(-1)?.text,/Security Verification/);
        assert.equal(recoveryPolls.length,probes,'wait while Arena is verifying the account');
        verification=false;
        recoveryReview=true;
        await tick();
        assert.equal(recoveryPolls.length,probes+1,'ask whether a new Desktop message is queued');
        assert.equal(reviewContinued,0,'leave the feedback panel alone until a Desktop message is queued');
        const newId='d7d1eedc5b0ef02472efaab42defc164';
        continuation={id:newId,text:'New message'};
        recoverQueued=true;
        draftValue='Keep browser draft';
        await tick();
        assert.equal(recoveryPolls.length,probes+1,'leave an existing draft alone');
        draftValue='';
        reply.nativeQuestion={status:'answered'};
        reply.imageChoices=[{status:'selected'},{status:'skipped'}];
        await tick();await tick();await tick();await tick();
        assert.equal(reviewContinued,1,'continue past the native feedback panel once');
        assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),[shotJob,newId]);
        assert.ok(recoveryPolls.every(id=>id===fault.id));
      } else assert.deepEqual(sent,[shotJob,next]);
      assert.equal(events.filter(e=>e.kind==='assistant').length,1);
      return;
    }
    if (outcome.startsWith('verification')) {
      const echo=rows.at(-1), pollsBeforeVerification=polls.length;
      const reply={role:'assistant',siteId:'chat-message-verified',nativeMessage:true,
        text:'A checked command',toolFrame:true,complete:true};
      const pendingCommand=outcome==='verification restores pending command';
      if (pendingCommand) { rows.push(reply); mutation(); now+=1200; mutation(); }
      rows.pop();
      verification=true;mutation();await tick();
      now+=60000;mutation();await tick();
      assert.equal(events.some(e=>['blocked','uncertain','assistant'].includes(e.kind)),false);
      assert.match(events.find(e=>e.kind==='busy' && /Security Verification/.test(e.text))?.text,/complete/i);
      assert.equal(polls.length,pollsBeforeVerification,'do not lease work while a manual check is visible');
      if (outcome==='verification navigation') {
        ctx.location.href='https://arena.ai/agent/another';
        await tick();
        assert.ok(departed);
        return;
      }
      verification=false;mutation();await tick();
      now+=4000;mutation();await tick();
      assert.equal(events.some(e=>e.kind==='blocked'),false,'give the exact row time to return');
      if (outcome==='verification restores history' || pendingCommand) {
        if (!pendingCommand) rows.push(echo);
        rows.push(reply);mutation();await tick();now+=1500;await tick();await tick();
        assert.deepEqual(events.filter(e=>e.kind==='assistant').map(e=>[e.text,e.toolFrame,e.replyTo]),[[reply.text,true,shotJob]]);
      } else {
        if (outcome==='verification changes identity') rows.push({...echo,siteId:'chat-message-tampered'});
        now+=7000;mutation();await tick();await tick();
        assert.match(events.find(e=>e.kind==='blocked')?.text,/transcript changed/i);
        assert.equal(events.some(e=>e.kind==='assistant'),false);
      }
      assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),[shotJob], 'do not send the request again');
      return;
    }
    if (outcome.startsWith('unpublished native command redraw')) {
      const command={role:'assistant',siteId:'chat-message-redrawn',nativeMessage:true,
        text:'Stable current command',toolFrame:true,complete:true};
      rows.push(command);mutation();now+=1200;mutation();
      command.toolFrame=false;
      if (outcome.endsWith('changed text')) command.text+=' changed';
      mutation();
      if (!outcome.endsWith('changed text')) {
        now+=1200;await tick();
        assert.equal(events.some(e=>e.kind==='assistant'),false,
          'wait for marked authority to return before publishing a complete candidate');
      }
      if (outcome.endsWith('times out')) {
        now+=10001;await tick();
        assert.match(events.find(e=>e.kind==='blocked')?.text,/did not regain visible authority/);
        assert.equal(events.some(e=>e.kind==='assistant'),false);
        return;
      }
      command.toolFrame=true;mutation();now+=1200;
      await tick();await tick();
      if (outcome.endsWith('changed text')) {
        assert.match(events.find(e=>e.kind==='blocked')?.text,/changed before publication \(text\)/);
        assert.equal(events.some(e=>e.kind==='assistant'),false);
        return;
      }
      assert.equal(events.some(e=>e.kind==='blocked'),false);
      assert.deepEqual(events.filter(e=>e.kind==='assistant').map(e=>[e.text,e.toolFrame]),[[command.text,true]]);
      return;
    }
    if (outcome.startsWith('acknowledged command')) {
      const siteId=outcome.endsWith('explicit ID') ? 'native-plan-id' : 'chat-message-reviewed-plan';
      const command={role:'assistant',siteId,nativeMessage:true,
        text:'Marked native plan',toolFrame:true,complete:true};
      rows.push(command);mutation();await tick();now+=1200;await tick();
      assert.equal(events.filter(e=>e.kind==='assistant' && e.toolFrame).length,1);

      command.toolFrame=false;
      const followup='beef1234567890abcdef123456789012';
      continuation={id:followup,text:'Desktop approved the plan'};
      if (outcome.includes('text restored')) command.text='Temporary redrawn native text';
      mutation();now+=1000;await tick();now+=1000;await tick();await tick();
      if (outcome.includes('text restored') || outcome.includes('text edited')) {
        assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),[shotJob],
          'send nothing until the published native row is verified');
        assert.equal(events.some(e=>e.kind==='blocked'),false,'allow the native row a bounded time to restore');
      }
      if (outcome.includes('text edited')) {
        assert.equal(polls.length,pollsBeforeEdit,'stop polling as soon as the acknowledged row is ambiguous');
        now+=10001;mutation();await tick();await tick();
        assert.match(events.find(e=>e.kind==='blocked')?.text,/row 4 \(text\)/);
        return;
      }
      if (outcome.includes('text restored')) {
        command.text='Marked native plan';mutation();
        await tick();now+=1000;await tick();await tick();
      }
      assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),[shotJob,followup],
        'a visual redraw of a published native command cannot block the plan result');
      assert.equal(events.filter(e=>e.kind==='assistant').length,1,'the historical command is never published again');
      return;
    }
    if (outcome.startsWith('mixed reply')) {
      const row={role:'assistant',siteId:'chat-message-mixed',nativeMessage:true,multipleFinalBodies:true,text:'',complete:false,toolFrame:false};
      rows.push(row);generating=true;mutation();now+=60000;await tick();
      assert.equal(events.some(e=>e.kind==='blocked'),false);
      generating=false;mutation();await tick();
      if (outcome==='mixed reply times out') {
        now+=30100;mutation();await tick();await tick();
        const blocked=events.filter(e=>e.kind==='blocked');
        assert.deepEqual(blocked.map(e=>e.job),[shotJob]);
        assert.match(blocked[0].text,/row 4.*multiple/i);
        assert.equal(events.some(e=>e.kind==='assistant'),false);
        return;
      }
      Object.assign(row,{text:'Checking WordPad.\n\nMy next step.\n\n```json\n{"protocol":"arena.harness.v1","name":"ask_user_question","arguments":{}}\n```',complete:true});
      mutation();await tick();assert.equal(events.some(e=>e.kind==='assistant'),false);
      now+=901;await tick();await tick();
      assert.deepEqual(events.filter(e=>e.kind==='assistant').map(e=>[e.text,e.toolFrame]),[[row.text,undefined]]);
      editDuringPrepare=outcome==='mixed reply changes during prepare';
      const again=await send({type:'prepare',chat});
      assert.equal(again.ok,!editDuringPrepare,'reconnect requires a stable completed mixed response');
      if (again.ok) {
        await send({type:'attach',chat,pageKey:again.pageKey,binding:'b2',reset:true});
        await tick();assert.equal(events.filter(e=>e.kind==='assistant').length,1,'binding a completed mixed reply never replays it');
      }
      return;
    }
    if (['prefix restored','permanent edit','permanent replacement','departed during redraw','quota during redraw','edited before publication','superseded before publication','superseded after failed RPC','superseded after lost ack','duplicate ID before publication','edited after lost ack'].includes(outcome)) {
      const original={...rows.at(-1)};
      const index=rows.length-1;
      const frame='\x60\x60\x60json\n{"$harness":"tool_call","name":"ask_user_question","arguments":{"questions":[{"id":"focus","question":"Continue?"}]}}\n\x60\x60\x60';
      rows[index] = outcome==='permanent replacement' ? {...original,siteId:'chat-message-other'}
        : {...original,role:'unknown',text:''};
      rows.push({role:'assistant',siteId:'chat-message-ask',nativeMessage:true,text:frame,toolFrame:true,complete:true});
      const before=polls.length;
      mutation();await tick();now+=1200;await tick();
      assert.equal(polls.length,before,'no polls while history is ambiguous');
      assert.equal(events.some(e=>['blocked','uncertain','assistant'].includes(e.kind)),false,'hold new outputs until the original native prefix returns');
      if(outcome==='prefix restored') {
        rows[index]=original;mutation();await tick();await tick();
        assert.deepEqual(events.filter(e=>e.kind==='assistant').map(e=>[e.text,e.toolFrame]),[[frame,true]]);
        const beforeReconnect=await send({type:'prepare',chat});
        assert.equal(beforeReconnect.ok,true);
        await send({type:'attach',chat,pageKey:beforeReconnect.pageKey,binding:'b2',reset:true});
        await tick();await tick();
        assert.equal(events.filter(e=>e.kind==='assistant').length,1,'completed question never repeats after rebind');
      } else if(outcome==='duplicate ID before publication') {
        rows[index]=original;mutation();
        rows.push({role:'assistant',siteId:'chat-message-ask',nativeMessage:true,text:'',complete:false});
        await tick();await tick();
        const reply=events.find(e=>e.kind==='assistant');
        assert.equal(reply?.text,frame);
        assert.equal(reply.replyTo,shotJob);
        assert.equal(reply.toolFrame,undefined,'an unmounted duplicate of the assistant identity invalidates a queued frame');
      } else if(outcome.startsWith('superseded ')) {
        rows[index]=original;mutation();
        if(outcome.startsWith('superseded after')) await tick();
        rows.push({role:'user',siteId:'chat-message-next',text:'New browser request'});
        mutation();await tick();await tick();
        const replies=events.filter(e=>e.kind==='assistant'),reply=replies.at(-1);
        assert.equal(reply?.text,frame);
        assert.equal(reply.toolFrame,undefined,'an unpublished command has lost its originating turn');
        assert.equal(reply.replyTo,shotJob);
        assert.equal(replies[0].id,reply.id);
        assert.equal(committed.get(reply.id).toolFrame,outcome==='superseded after lost ack' || undefined);
      } else if(outcome.startsWith('edited ')) {
        rows[index]=original;mutation();
        if(outcome==='edited after lost ack') await tick();
        rows[index]={...original,text:'changed'};
        mutation();await tick();await tick();
        const replies=events.filter(e=>e.kind==='assistant');
        if(outcome==='edited before publication') {
          assert.equal(replies.length,0,'queued unpublished tool must never reach the journal after the transcript changes');
          now+=10001;mutation();await tick();
          assert.deepEqual(events.filter(e=>e.kind==='blocked').map(e=>e.job),[shotJob]);
        } else {
          assert.equal(replies.length,2);
          assert.equal(replies[0].id,replies[1].id,'lost ack retries the same id/reply exactly');
        }
      } else if(outcome==='quota during redraw') {
        issue={kind:'limited',text:'Limit reached'};
        mutation();await tick();await tick();
        assert.deepEqual(events.filter(e=>e.kind==='limited').map(e=>e.job),[shotJob]);
        assert.equal(events.some(e=>e.kind==='assistant'),false);
      } else if(outcome==='departed during redraw') {
        ctx.location.href='https://arena.ai/agent/other';
        rows[index]=original;now+=60000;mutation();await tick();
        assert.equal(events.some(e=>e.kind==='assistant'),false);
      } else {
        if(outcome==='permanent edit') rows[index]={...original,text:'changed result'};
        now+=60000;
        mutation();await tick();await tick();
        const blocked=events.filter(e=>e.kind==='blocked');
        assert.deepEqual(blocked.map(e=>e.job),[shotJob]);
        assert.match(blocked[0].text,/row 3\b/i);
        assert.match(blocked[0].text,outcome==='permanent edit' ? /text/i : /identity|site.?id/i);
        assert.equal(events.some(e=>e.kind==='assistant'),false);
      }
      return;
    }
    const pending={role:'unknown',nativeMessage:true,siteId:'chat-message-answer',text:'Processing image'};
    rows.push(pending);
    generating=outcome==='settles';
    mutation();await tick();
    assert.equal(events.some(e=>e.kind==='assistant'),false);
    if(outcome==='settles') {
      now+=60000;
      await tick();
      generating=false;
      Object.assign(pending,{role:'assistant',text:'a completed tool call',toolFrame:true,complete:true});
      mutation();now+=1000;await tick();await tick();
      assert.deepEqual(events.filter(e=>e.kind==='assistant').map(e=>[e.text,e.toolFrame]),[['a completed tool call',true]]);
      assert.equal(events.some(e=>e.kind==='blocked'),false);
    } else {
      assert.equal(events.some(e=>e.kind==='blocked'),false);
      if(outcome==='timed out') now+=60000;
      if(outcome==='another row follows') rows.push({role:'assistant',text:'unpaired',complete:true});
      if(outcome==='history edited') rows[0].text='edited old question';
      mutation();await tick();await tick();
      const stopped=events.filter(e=>e.kind==='blocked');
      assert.deepEqual(stopped.map(e=>e.job),[shotJob],'one permanent failure reaches the waiting Desktop job');
      assert.ok(stopped[0].text);assert.equal(events.some(e=>e.kind==='assistant'),false);
    }
  });
}
