const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conversation, delivery, pairingSettlement, Transcript } = require('../core.js');

const user = (text) => ({ role: 'user', text });
const assistant = (text, complete = false) => ({ role: 'assistant', text, complete });
const history = [user('earlier question'), assistant('earlier answer', true)];
const events = (turns) => turns.map(({ id, ...event }) => event);

test('return verifies every previously captured source even when the earlier link label stays the same',()=>{
  const rows=[1,2].map(i=>({...assistant('Guide',true),nativeMessage:true,siteId:'chat-message-'+i}));
  const log=new Transcript(rows);
  log.seen[0].sourceOrigin='copy';
  log.seen[0].originalMarkdown='[Guide](https://example.test/original)';
  const reads=[];
  const read=(row,origin)=>{reads.push([row.siteId,origin]);return '[Guide](https://example.test/edited)';};
  assert.ok(log.returnProblem(rows,read));
  assert.deepEqual(reads,[['chat-message-1','copy']]);
  assert.ok(log.returnProblem(rows,()=>undefined),'missing previously captured authority cannot confirm a return');
  assert.equal(log.returnProblem(rows,()=>log.seen[0].originalMarkdown),'');
});

test('return verifies a completed Arena stream after changing chats clears its browser stream cache',()=>{
  const row={...assistant('СВЯЗЬ-54',true),nativeMessage:true,siteId:'chat-message-a54'};
  function check(stream,copy,display=row,original=row.text) {
    const log=new Transcript([row]), reads=[];
    Object.assign(log.seen[0],{sourceOrigin:'stream',originalMarkdown:original});
    const reason=log.returnProblem([display],(_row,origin)=>{reads.push(origin);return origin==='stream'?stream:copy;});
    return {reason,reads};
  }
  const gone={status:'unobserved'};
  assert.deepEqual(check(gone,'СВЯЗЬ-54'),{reason:'',reads:['stream','copy']});
  assert.equal(check(gone,'СВЯЗЬ-54\r\n').reason,'');
  assert.ok(check(gone,undefined).reason,'a visible label cannot establish its original Markdown link destination');
  assert.ok(check(gone,undefined,{...row,text:'Different'}).reason);
  assert.ok(check(gone,'[Guide](https://example.test/new)',row,'[Guide](https://example.test/old)').reason);
  assert.ok(check(gone,undefined,{...row,siteId:'other'}).reason);
  for (const stream of ['Different bytes',{status:'conflict'},{status:'incomplete'}]){
    const {reason,reads}=check(stream,'СВЯЗЬ-54');
    assert.ok(reason);
    assert.deepEqual(reads,['stream'],'available or conflicting stream authority is definitive');
  }
});

test('only exact stable Agent Mode addresses can bind', () => {
  assert.equal(typeof conversation, 'function');
  assert.equal(conversation('https://arena.ai/agent/one-2/'), 'https://arena.ai/agent/one-2');
  for (const address of ['https://arena.ai/agent', 'https://arena.ai/c/one', 'https://arena.ai/agent/new',
    'https://other.arena.ai/agent/1', 'https://evil@arena.ai/agent/1', 'https://arena.ai:81/agent/1',
    'https://arena.ai/agent/1?chat=2', 'https://arena.ai/agent/1#two']) assert.equal(conversation(address), null);
});

test('skips prior history, forwards distinct equal browser messages in order, never streams partial tools', () => {
  assert.equal(typeof Transcript, 'function');
  const log = new Transcript(history);
  const rows = [...history, user('again'), assistant('partial')];
  const first = log.scan(rows, { generating: true, idle: false });
  assert.deepEqual(events(first), [{ kind: 'user', text: 'again' }]);
  assert.deepEqual(log.scan(rows, { generating: true, idle: false }), []);
  assert.deepEqual(log.scan(rows, { generating:false, idle:true }), [], 'a transient idle composer does not complete analysis');
  rows[3] = assistant('final', true);
  const final = log.scan(rows, { generating: false, idle: true });
  assert.deepEqual(events(final), [{ kind: 'assistant', text: 'final', replyTo:first[0].id }]);
  rows.push(user('again'), assistant('another', true));
  const next = log.scan(rows, { generating: false, idle: true });
  assert.deepEqual(events(next), [{ kind: 'user', text: 'again' }, { kind: 'assistant', text: 'another',replyTo:next[0].id }]);
  assert.notEqual(first[0].id, next[0].id);
});

test('unknown completion, missing user, and changed historical prefix cannot issue a tool', () => {
  assert.equal(typeof Transcript, 'function');
  const signal = { generating: false, idle: true };
  const log = new Transcript(history);
  assert.deepEqual(log.scan([...history, assistant('orphan', true)], signal), []);
  assert.ok(log.fault);
  const valid = new Transcript(history);
  const rows = [...history, user('hello'), assistant('tool')];
  assert.deepEqual(events(valid.scan(rows, signal)), [{ kind: 'user', text: 'hello' }]);
  assert.deepEqual(valid.scan(rows, signal), []);
  assert.ok(valid.waiting);
  assert.deepEqual(valid.scan([user('different'), ...rows.slice(1)], signal), []);
  assert.ok(valid.fault);
  const mounting = new Transcript(history);
  mounting.scan([...history,user('')],signal);
  assert.equal(mounting.pendingRows,true,'pending browser turn blocks concurrent terminal offer');
  mounting.scan([...history,user('new')],signal);
  assert.equal(mounting.pendingRows,false);
});

const stamp='0123456789abcdef0123456789abcdef';
function stampedUser(text,id=stamp) {
  const outgoing=delivery(text,id);
  return {...user(outgoing.text),siteId:'chat-message-'+id,lastLine:outgoing.receipt};
}

test('prefix-only checks cannot mistake an intentionally omitted current row for erasure', () => {
  const log=new Transcript(history), echo=stampedUser('save');
  const current={...assistant('complete marked command',true),nativeMessage:true,siteId:'chat-message-current',toolFrame:true};
  log.expect(stamp,'save',null,echo.lastLine);
  log.scan([...history,echo,current],{generating:false,publishNativeFinal:false});
  assert.deepEqual(log.scan([...history,echo],{generating:false,historyOnly:true}),[]);
  assert.equal(log.fault,'');
  log.scan([...history,echo],{generating:false});
  assert.match(log.fault,/changed before publication \(presence\)/);
});

test('pairing advertises only a unique native receipt immediately before a completed answer', () => {
  const echo={...stampedUser('save'),nativeMessage:true};
  const result={...assistant('verified native answer',true),siteId:'chat-message-final',nativeMessage:true};
  assert.equal(pairingSettlement([echo,result]),stamp);
  for (const rows of [
    [echo], [echo,{...result,complete:false}], [echo,{...result,artifact:{pending:true}}],
    [echo,{...result,artifact:{error:'broken'}}], [echo,{...result,nativeQuestion:{status:'active'}}],
    [echo,{...result,nativeMessage:false}], [{...echo,nativeMessage:false},result],
    [{...echo,siteId:'chat-message-duplicate'},echo,result], [echo,user('different'),result],
  ]) assert.equal(pairingSettlement(rows),undefined);
});
test('a marked reply needs a current stamped turn and publishes once without a model receipt', () => {
  const state={generating:false};
  for(const [origin,marked,permitted] of [[stamp,true,true],['f'.repeat(32),true,false],[null,true,true],[undefined,true,false],[stamp,false,false]]) {
    const log=new Transcript(history), echo=stampedUser('save');
    if(origin!==undefined) log.expect(origin,'save',null,echo.lastLine);
    const rows=[...history,echo,{...assistant('Marked example',true),siteId:'current-answer',toolFrame:marked}];
    const [request,answer]=log.scan(rows,state);
    if(origin===null) assert.equal(request.id,stamp);
    assert.equal(answer.toolFrame,permitted || undefined);
    assert.equal(answer.replyTo,origin ?? request.id);
    assert.equal(answer.text,'Marked example');
    assert.deepEqual(log.scan(rows,state),[]);
  }
});

test('copied tool source travels separately and is rechecked at publication', () => {
  const log = new Transcript(history), echo = stampedUser('read');
  const source = JSON.stringify({$harness:'tool_call',turn_id:stamp,name:'read',arguments:{filePath:'C:\\Users\\test.txt'}});
  const row = {...assistant('fragmented rendered command',true),siteId:'chat-message-copy',nativeMessage:true,
    toolFrame:true,toolSource:source,responseText:'An explanation'};
  const rows = [...history,echo,row];
  log.expect(stamp,'read',null,echo.lastLine);
  const [,answer] = log.scan(rows,{generating:false});
  assert.equal(answer.text,'An explanation');
  assert.equal(answer.toolSource,source);
  assert.ok(log.currentCommand(answer,rows));
  assert.equal(log.currentCommand(answer,[...rows.slice(0,-1),{...row,toolSource:source+' '}]),false);
  assert.deepEqual(log.scan(rows,{generating:false}),[]);
});

test('a historical assistant identity cannot be reused by a marked reply after a fresh delivery or a reconnect', () => {
  const state={generating:false};
  for (const identity of [{siteId:'answer-1'}, {domKey:17}]) {
    const oldAnswer={...assistant('Exact command',true),...identity,toolFrame:true};
    const past=[...history,user('previous question'),oldAnswer];
    for (const reconnect of [false,true]) {
      const log=new Transcript(reconnect ? past : history);
      if (!reconnect) log.scan(past,state);
      const echo=stampedUser('new request'); log.expect(stamp,'new request',null,echo.lastLine);
      const [sent,answer]=log.scan([...past,echo,{...oldAnswer}],state);
      assert.equal(sent.kind,'sent');
      assert.equal(answer.text,oldAnswer.text);
      assert.equal(answer.replyTo,stamp);
      assert.equal(answer.toolFrame,undefined);
    }
  }
  // A node without a site ID can be moved below the new user turn while a fresh copy fills its old location.
  const old={...assistant('Exact command',true),domKey:17,toolFrame:true}, echo=stampedUser('save');
  const log=new Transcript([...history,old]);
  log.expect(stamp,'save',null,echo.lastLine);
  const reply=log.scan([...history,{...old,domKey:18},echo,old],state).at(-1);
  assert.equal(reply?.text,old.text);
  assert.equal(reply.toolFrame,undefined);
});

test('stopping a generation cannot authorize a partially streamed tool request', () => {
  const log = new Transcript(history);
  const echo=stampedUser('run'); log.expect(stamp,'run',null,echo.lastLine);
  const rows = [...history,echo,{...assistant('frame'),toolFrame:true,siteId:'answer'}];
  log.scan(rows,{idle:false,generating:true});
  assert.deepEqual(log.scan(rows,{idle:true,generating:false}),[]);
  rows.at(-1).complete = true;
  assert.equal(log.scan(rows,{idle:true,generating:false})[0].toolFrame,true);
});

test('an unsigned native attachment-only turn remains passive and does not trap the next task', () => {
  const log=new Transcript(history), state={generating:false};
  const rows=[...history,{...user(''),nativeMessage:true,siteId:'attachment-only'}];
  assert.deepEqual(log.scan(rows,state),[]);
  rows.push({...assistant('example',true),toolFrame:true});
  const [request,reply]=log.scan(rows,state);
  assert.equal(request.text,'');
  assert.equal(reply.replyTo,request.id);
  assert.equal(reply.toolFrame,undefined);
  assert.equal(log.pendingRows,false);
});

test('terminal sends are confirmed by a new exact user bubble, ambiguous echoes suspend', () => {
  assert.equal(typeof Transcript, 'function');
  const signal = { generating: false, idle: true };
  const log = new Transcript(history);
  log.expect('job-A', 'Run test');
  assert.deepEqual(events(log.scan([...history, user('Run test')], signal)), [{ kind: 'sent', job: 'job-A' }]);
  const conflict = new Transcript(history);
  conflict.expect('job-B', 'Run test');
  assert.deepEqual(events(conflict.scan([...history, user('Other')], signal)).map(e => e.kind), ['uncertain']);
  assert.ok(conflict.fault);
});

test('a popup skill needs a fresh browser echo and creates a browser-initiated user turn', () => {
  const log = new Transcript(history);
  log.expect(null,'question with skill');
  const signal = {idle:true,generating:false};
  const typed = log.scan([...history,user('question with skill')],signal);
  assert.deepEqual(events(typed),[{kind:'user',text:'question with skill'}]);
  const lost = new Transcript(history);
  lost.expect(null,'question with skill');
  assert.deepEqual(events(lost.fail('No browser echo')), [{kind:'blocked',text:'No browser echo'}]);
});

test('edits to consumed same-ID messages or their tool authority stop later deliveries', () => {
  const known = [
    {...user('read a'),siteId:'q1'},
    {...assistant('plain answer',true),siteId:'a1'},
    {...user('read b'),siteId:'q2'},
    {...assistant('{"name":"read","file":"b"}',true),toolFrame:true,siteId:'a2'}
  ];
  const idle={idle:true,generating:false};
  for (const [index,edit] of [
    [0,{text:'read c'}],[1,{text:'edited answer'}],
    [3,{text:'{"name":"read","file":"c"}'}],[3,{toolFrame:false}],
    [1,{siteId:'a2'}]
  ]) for (const fromHistory of [true,false]) {
    const log = new Transcript(fromHistory ? known : []);
    if (!fromHistory) log.scan(known,idle);
    const changed = known.map((row,i)=>i===index ? {...row,...edit} : row);
    assert.deepEqual(log.scan([...changed,user('next'),{...assistant('new call',true),toolFrame:true}],idle),[]);
    assert.ok(log.fault);
  }
});

test('authority-only redraw of a native row from pairing history stays inert', () => {
  const idle={generating:false};
  const old={...assistant('Exact archived body',true),siteId:'chat-message-archived',nativeMessage:true,toolFrame:false};
  const paired=[...history,old], drawn={...old,toolFrame:true};
  const log=new Transcript(paired);
  const echo=stampedUser('save');
  log.expect(stamp,'save',null,echo.lastLine);
  const current={...assistant('fresh marked result',true),siteId:'chat-message-new',nativeMessage:true,toolFrame:true};
  const rows=[...history,drawn,echo,current];
  const [sent,answer]=log.scan(rows,idle);
  assert.equal(sent?.kind,'sent');
  assert.equal(answer?.text,current.text);
  assert.equal(answer?.toolFrame,true,'only the new response can get tool authority');
  assert.ok(log.currentCommand(answer,rows));
  assert.deepEqual(log.scan(rows,idle),[]);
  assert.equal(log.currentCommand(answer,[...rows.slice(0,-1),{...current,toolFrame:false}]),false,
    'a frame observed under this binding is checked before publication');

  const forged=new Transcript(paired);
  forged.expect(stamp,'save',null,echo.lastLine);
  const replay=forged.scan([...history,drawn,echo,drawn],idle);
  assert.equal(replay.at(-1)?.toolFrame,undefined,'an archived native identity cannot be replayed');
  for (const altered of [{...drawn,text:'edited'}, {...drawn,nativeMessage:false}]) {
    const checked=new Transcript(paired);
    checked.scan([...history,altered],idle);
    assert.match(checked.fault,/transcript changed/);
  }
});

test('only an acknowledged copy snapshot can verify a changed rendering, with bounded recovery',t=>{
  let now=10000;
  t.mock.method(Date,'now',()=>now);
  const row={...assistant('normal answer',true),nativeMessage:true,siteId:'chat-message-proof'};
  for(const outcome of ['restored','timeout','changed','no original','unacknowledged','duplicate','media']) {
    const log=new Transcript([]),rows=[user('question'),row];
    let source='normal **answer**',reads=0;
    const state={generating:false,captureSource:()=>outcome==='no original'?undefined:source,
      historySource:()=>{reads++;return source;}};
    const answer=log.scan(rows,state).at(-1);
    if(outcome!=='unacknowledged')log.acknowledgeReply(answer);
    rows[1]={...row,text:'normal\n\nanswer'};
    if(outcome==='media')rows[1].artifact={pending:true};
    if(outcome==='duplicate')rows.push({...rows[1]});
    source=outcome==='changed'?'normal *answer*':undefined;
    log.scan(rows,state);
    if (outcome==='restored' || outcome==='timeout') {
      assert.equal(log.fault,'');assert.equal(log.historyChangedAt,now);
      log.scan(rows,state);assert.equal(reads,1,'throttle Copy while missing');
      if(outcome==='restored')source='normal **answer**';
      now+=10001;log.scan(rows,state);
      if(outcome==='restored')assert.equal(log.fault,'');
      else assert.match(log.fault,/source unavailable/);
    } else assert.match(log.fault,/transcript changed/);
  }
});

test('only the matching browser echo consumes the pending catalogue ID', () => {
  const log = new Transcript(history), signal={idle:true,generating:false};
  log.expect(null,'catalogue\n\nhello','ctx1');
  assert.equal(log.scan([...history,user('catalogue\n\nhello')],signal)[0].contextId,'ctx1');
  const other = new Transcript(history);
  other.expect(null,'catalogue\n\nhello','ctx1');
  assert.equal(other.scan([...history,user('unrelated')],signal)[0].kind,'blocked');
});

test('only the bridge-issued receipt separator can settle after acknowledging a native screenshot echo', () => {
  const id='5e67ac20f5774045aa3aa3456f96c61f', receipt='Bridge delivery '+id;
  const body='DeepSeek Harness tool result:\n{"toolCallId":"snap"}\n\nKeep this paragraph.';
  const idle={generating:false};
  const initial={...user(body+'\n\n'+receipt),lastLine:receipt,siteId:'chat-message-original',nativeMessage:true};
  const ask={...assistant('ask_user_question',true),toolFrame:true,siteId:'chat-message-ask'};
  const settled={...initial,text:body+'\n'+receipt};
  const log=new Transcript([]);
  log.expect(id,body,null,receipt);
  assert.deepEqual(log.scan([initial],idle).map(e=>e.kind),['sent']);
  assert.deepEqual(events(log.scan([settled,ask],idle)),[{kind:'assistant',text:ask.text,toolFrame:true,replyTo:id}]);
  assert.equal(log.scan([initial,ask],idle).length,0,'returning to original rendering cannot repeat the question');
  for(const unverified of [
    new Transcript([initial]),
    new Transcript([{...initial,role:'assistant',toolFrame:true}])
  ]) {
    assert.deepEqual(unverified.scan([settled,ask],idle),[]);
    assert.ok(unverified.fault,'the receipt string in arbitrary chat text is inert');
  }
  const edited=new Transcript([]);
  edited.expect(id,body,null,receipt);
  edited.scan([initial],idle);
  assert.deepEqual(edited.scan([{...settled,text:settled.text.replace('snap','other')},ask],idle),[],
    'preserving the receipt does not authorize an altered tool result');
});

test('a confirmed user echo survives a redraw when its original source is identical', () => {
  const echo = {...stampedUser('Code:\n\tstep()'), nativeMessage:true};
  const original = echo.text;
  const log = new Transcript([]);
  const state = {generating:false, historySource:row=>row.role==='user' ? original : undefined};
  log.expect(stamp, 'Code:\n\tstep()', null, echo.lastLine);
  assert.deepEqual(log.scan([echo],state).map(event=>event.kind),['sent']);
  const redrawn = {...echo,text:original.replace('\tstep()', 'step()\t')};
  const command = {...assistant('one command',true),toolFrame:true,siteId:'command'};
  assert.deepEqual(log.scan([redrawn,command],state).map(event=>event.kind),['assistant']);
  assert.equal(log.fault,'');
  assert.deepEqual(log.scan([redrawn,command],state),[]);
});

test('publication detects an original indentation edit even with an unchanged rendering', () => {
  const echo = {...stampedUser('Code:\n\tstep()'), nativeMessage:true};
  const log = new Transcript([]);
  let source = echo.text;
  const state = {generating:false,historySource:()=>source};
  log.expect(stamp,'Code:\n\tstep()',null,echo.lastLine);
  log.scan([echo],state);
  source = source.replace('\tstep()', '\t\tstep()');
  const command = {...assistant('must not run',true),toolFrame:true,siteId:'command'};
  assert.deepEqual(log.scan([echo,command],{...state,verifyEcho:true}),[]);
  assert.match(log.fault,/row 1 \(original source\)/);
  assert.equal(log.transcriptChanged,true);
  assert.deepEqual(log.scan([echo,command],state),[]);
});

test('a missing user source at publication cannot reset the verification deadline', (t) => {
  let now = 1000;
  t.mock.method(Date,'now',()=>now);
  const echo = {...stampedUser('Code:\n\tstep()'),nativeMessage:true};
  const log = new Transcript([]);
  let source = echo.text;
  const state = {generating:false,historySource:()=>source};
  log.expect(stamp,'Code:\n\tstep()',null,echo.lastLine);
  log.scan([echo],state);
  source = undefined;
  assert.deepEqual(log.scan([echo],{...state,verifyEcho:true}),[]);
  now += 3000;
  log.scan([echo],state);
  assert.equal(log.historyChangedAt,1000);
  now += 7100;
  log.scan([echo],state);
  assert.match(log.fault,/row 1 \(source unavailable\)/);
});

test('an image-only final waits for verified artifact bytes and is emitted exactly once', () => {
  const log=new Transcript(history), signal={generating:false,idle:true};
  const picture={mediaType:'image/png',data:'aW1hZ2U='};
  const row={...assistant('',true),siteId:'generated',artifactsPending:true};
  const rows=[...history,user('draw'),row];
  const observed=log.scan(rows,signal);
  assert.deepEqual(observed.map(e=>e.kind),['user']);
  assert.deepEqual(log.scan(rows,signal),[]);
  rows[3]={...row,artifactsPending:false,images:[picture],toolFrame:true};
  assert.deepEqual(events(log.scan(rows,signal)),[{kind:'assistant',text:'',images:[picture],replyTo:observed[0].id}]);
  assert.deepEqual(log.scan(rows,signal),[]);
  const known=new Transcript(rows);
  assert.deepEqual(known.scan(rows,signal),[]);
  const terminal=new Transcript(history);terminal.expect('terminal-job','draw');
  assert.equal(terminal.scan(rows,signal).at(-1).replyTo,'terminal-job');
});

test('generation intent holds captions but preserves ordinary inspection, tool requests and explicit failures',()=>{
  const idle={generating:false,idle:true};
  function answer(prompt,row){
    const log=new Transcript(history);
    const echo=stampedUser(prompt); log.expect(null,prompt,null,echo.lastLine);
    return events(log.scan([...history,echo,{...assistant('Caption',true),siteId:'answer',...row}],idle)).map(e=>e.kind);
  }
  for(const request of ['Please generate a photo of the bridge.','Draw a cat.', 'Use the native image generator to depict a red bird.','Generate a watercolor of a lighthouse.','Нарисуй рыжего кота.','Сгенерируй изображение ночного вокзала.']) {
    assert.deepEqual(answer(request,{}),['user'],request);
    assert.deepEqual(answer(request,{text:'Image generation failed.'}),['user','assistant']);
    assert.deepEqual(answer(request,{text:'Image generation failed.',artifact:{pending:true,progressOnly:true},artifactsPending:true}),['user','assistant']);
    assert.deepEqual(answer(request,{text:'Tool frame',toolFrame:true}),['user','assistant']);
  }
  for(const inspect of ['Describe the attached image.','Прочитай PNG и опиши цвета.','Explain how to generate an image.','How do I create a Docker image?', 'Create a Docker image for my Node service.', 'Draw a conclusion from the table.'])
    assert.deepEqual(answer(inspect,{}),['user','assistant'],inspect);
  for(const request of ['Show a JSON example of how to call an image tool.', 'Give me a schema to create an image.',
    'I need a JSON example of how to call an image tool.', 'Мне нужен пример JSON о том, как вызвать генератор изображений.',
    'Can you show me a JSON example of how to call an image tool?', 'Explain how to generate and render an image.',
    'Could you please explain how to generate and render an image?', 'Объясни, как сгенерировать и нарисовать картинку.',
    'Generate a JSON example of an image tool call.', 'Show how to invoke an image tool as JSON.',
    'Покажи JSON-пример того, как использовать генератор изображений.', 'Напиши пример JSON для команды «нарисуй кота».']) {
    assert.deepEqual(answer(request,{text:'Example:\n\n```json\n{"name":"image"}\n```'}),['user','assistant'],request);
    assert.deepEqual(answer(request,{text:'{"name":"image"}'}),['user','assistant'],request);
    assert.deepEqual(answer(request,{text:'Example:\n\n```\n{"name":"image"}\n```'}),['user','assistant'],request);
    assert.deepEqual(answer(request,{text:'Here is the JSON: {"name":"image"}'}),['user','assistant'],request);
  }
  for(const request of ['Draw a cat.', 'Draw a cat and return its metadata as JSON.',
    'Create a sample image of a blue cup.', 'Generate an example picture of a lighthouse.',
    'Return a JSON summary and draw a cat.', 'Нарисуй кота и верни JSON.', 'Покажи JSON и нарисуй кота.',
    'Explain how to generate and render an image, then draw a cat.', 'Could you generate a photo of the cat?',
    'Объясни, как сгенерировать и нарисовать картинку. Затем нарисуй кота.',
    'Create an image from this JSON schema.', '!image cat']) {
    const log=new Transcript(history), echo=stampedUser(request);log.expect(stamp,request,null,echo.lastLine);
    const rows=[...history,echo,{...assistant('{"prompt":"cat"}',true),siteId:'drawing'}];
    assert.deepEqual(log.scan(rows,idle).map(e=>e.kind),['sent'],request);
    rows.at(-1).images=[{mediaType:'image/png',data:'AAAA'}];
    assert.deepEqual(log.scan(rows,idle).map(e=>e.images),[rows.at(-1).images],request);
  }
  assert.deepEqual(answer('!image lighthouse',{text:'{"name":"image"}'}),['user']);
  assert.deepEqual(answer('Draw a cat.',{text:'{"name":"image"}',artifact:{pending:true},artifactsPending:true}),['user']);
  assert.deepEqual(answer('Go ahead',{generationHint:true}),['user']);
  for(const prefix of ['', 'DeepSeek Harness Desktop is connected. Native tool catalog: []\nAvailable skills: []\n\n','Local project context from DeepSeek Harness. Tool catalog: []\nLocal skill catalog: []\n\n']){
    const request=prefix+'!image 赤い灯台を描いてください';
    assert.deepEqual(answer(request,{}),['user']);
    assert.deepEqual(answer(request,{text:'Tool frame',generationHint:true,toolFrame:true}),['user']);
    assert.deepEqual(answer(request,{text:'Image generation failed.'}),['user','assistant']);
    assert.deepEqual(answer(request,{text:'New output after the previous image generation failed.'}),['user']);
  }
  assert.deepEqual(answer('A quote with !image in the middle',{}),['user','assistant']);
  assert.deepEqual(answer('DeepSeek Harness tool result:\n!image not a new request',{}),['user','assistant']);
});

test('a Desktop request to plan image work may return a local plan review instead of image bytes',()=>{
  const context='DeepSeek Harness Desktop is connected. Native tool catalog: []\nAvailable skills: []\n\n';
  const request=context+'!image lighthouse\n\nDeepSeek Harness plan mode: ACTIVE. Use only read-only inspection.';
  const log=new Transcript(history), echo=stampedUser(request);
  log.expect(stamp,request,null,echo.lastLine);
  const reply={...assistant('review plan',true),siteId:'plan-review',toolFrame:true};
  assert.equal(log.scan([...history,echo,reply],{generating:false}).at(-1).toolFrame,true);
});
