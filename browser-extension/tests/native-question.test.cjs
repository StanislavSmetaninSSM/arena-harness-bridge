const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

for(const scenario of ['selected','summary then reply','prose beside summary','confirmation lost','failed before choice','foreign choice','unsupported','display only','display only Summary','display only removed','display only same row prose','closed handshake','dismissed handshake','verification before selection confirmation','two audio tracks beside a three-option question','audio question sources change after an unacknowledged event']) {
  test('site question '+scenario,async()=>{
    const chat='https://arena.ai/agent/native', events=[], choices=[], polls=[], fields={};
    const rows=[{role:'user',text:'past'},{role:'assistant',text:'done',complete:true}];
    const staleComparison=scenario.startsWith('audio question sources');
    const comparison=staleComparison||scenario.startsWith('two audio tracks');
    const card={id:'chat-message-native',question:'Which color?',options:comparison?['Amber','Indigo','Neither']:['Amber','Indigo']};
    const item={role:'assistant',nativeMessage:true,siteId:card.id,prose:'Choose.',text:'Which color? Amber Indigo',
      nativeQuestion:{...card,status:'active'},complete:false};
    const tracks=['/track-a','/track-b'];
    if (comparison) item.audioArtifact={players:[{},{}],sources:tracks};
    let listener,tick,notify,now=1000,offered=false,deliver=false,verification=false,failedQuestion=false;
    const sent=card=>JSON.parse(JSON.stringify(card));
    const ctx=vm.createContext({crypto,URL,location:{href:chat},Date:class extends Date{static now(){return now;}},
      document:{documentElement:{}},addEventListener(){},setInterval:fn=>tick=fn,
      MutationObserver:class{constructor(fn){notify=fn;}observe(){}},
      ArenaNativeQuestions:{async encodeAudio(part){return part.sources.map(data=>({mediaType:'audio/mpeg',data}));}},
      chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{
        if(msg.type==='event')events.push(sent(msg.event));
        if(staleComparison && msg.event?.questionAudio && !failedQuestion) {
          failedQuestion=true;
          item.audioArtifact={...item.audioArtifact,sources:['/different','/track-b']};
          return {ok:false,error:'loopback did not acknowledge the question'};
        }
        const reply={ok:true,supportsNativeQuestions:scenario!=='unsupported',supportsAudioQuestions:comparison};
        if(msg.event?.nativeQuestion)Object.assign(reply,{nativeQuestionHandled:scenario.startsWith('display only')?'display-only':'interactive',
          nativeQuestionId:card.id,replyTo:'request-job'});
        if(msg.type==='poll'){
          polls.push(msg);
          if(msg.nativeQuestionClosed && scenario.endsWith('handshake'))reply.nativeQuestionClosed=msg.nativeQuestionId;
          if(msg.ready && !offered){offered=true;reply.job={id:'request-job',text:'Ask the user'};}
          else if(msg.nativeQuestionId===card.id && deliver){
            deliver=false;reply.job={id:'answer-job',nativeAnswer:{...card,answer:scenario==='foreign choice'?'Not listed':'Indigo'}};
          }
        }
        return reply;
      }}},
      ArenaPage:class{
        state(){return {field:fields,ready:!verification&&(rows.at(-1)!==item || item.complete),idle:!verification,generating:false,value:'',verification};}
        rows(){return rows.map(r=>({...r}));}
        async submit(job,draft,guard,click){assert.ok(guard());click();rows.push({role:'user',text:job.text,siteId:'chat-message-'+job.id,lastLine:job.text.split('\n').at(-1)});}
        selectNativeAnswer(answer){
          choices.push(answer.answer);
          if (scenario==='verification before selection confirmation') { verification=true; rows.pop(); return; }
          const summary=['summary then reply','prose beside summary','confirmation lost'].includes(scenario);
          item.nativeQuestion=summary
            ? {id:card.id,question:card.question,options:[],status:'answered',summary:true,selected:answer.answer}
            : {...card,status:'answered',selected:answer.answer};
          if(summary) {item.prose='';item.text='Summary: Indigo';item.complete=true;}
          notify();
        }
      }});
    for(const file of ['core.js','content.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
    const ctrl=msg=>new Promise(resolve=>listener(msg,{id:'test'},resolve));
    const prepared=await ctrl({type:'prepare',chat});
    await ctrl({type:'attach',chat,binding:'b1',pageKey:prepared.pageKey});
    await tick();await tick();rows.push(item);notify();now+=1900;await tick();await tick();
    if (comparison) {now+=2000;await tick();await tick();}
    if(scenario==='unsupported'){
      assert.equal(events.some(e=>e.nativeQuestion||e.toolFrame),false);
      assert.ok(events.some(e=>e.kind==='assistant' && e.text.includes('Which color?')));
      return;
    }
    const asks=events.filter(e=>e.nativeQuestion);
    assert.deepEqual(asks.map(e=>[e.nativeQuestion,e.replyTo]),[[card,'request-job']]);
    if (comparison) assert.deepEqual(asks[0].questionAudio?.map(track=>track.data),tracks);
    if(staleComparison) {
      now+=2000;await tick();await tick();
      assert.equal(events.filter(e=>e.questionAudio).length,1,'never retry the old tracks after an actual change');
      assert.ok(events.some(e=>e.kind==='blocked'&&e.job==='request-job'&&e.text.includes('audio changed')));
      assert.deepEqual(choices,[]);
      return;
    }
    if(scenario.startsWith('display only') || scenario.endsWith('handshake')){
      if(scenario.startsWith('display only'))assert.ok(!polls.some(p=>p.nativeQuestionId));
      item.nativeQuestion={...card,status:'failed'};item.text='Question failed';item.complete=true;
      if(scenario==='display only Summary') {item.prose='';item.text='Summary';item.nativeQuestion={id:card.id,
        question:card.question,status:'answered',options:[],summary:true,selected:'Indigo'};}
      if(scenario==='display only removed')rows.pop();
      if(scenario==='display only same row prose'){delete item.nativeQuestion;item.prose=item.text='Resolved.';}
      if(scenario==='dismissed handshake') {item.prose='';item.text='Questions dismissed';item.nativeQuestion={id:card.id,status:'dismissed',options:[]};}
      notify();now+=2000;await tick();await tick();now+=1000;await tick();
      if(scenario.endsWith('handshake'))assert.ok(polls.some(p=>p.nativeQuestionClosed && p.nativeQuestionId===card.id));
      assert.equal(polls.at(-1).ready,true,'idle composer can receive another ordinary turn after a spent widget');
      if(scenario==='display only Summary'||scenario==='dismissed handshake'){
        rows.push({role:'assistant',siteId:'late',nativeMessage:true,text:'late widget reply',complete:true,toolFrame:true});
        notify();now+=1000;await tick();await tick();
        assert.equal(polls.at(-1).ready,true,'late passive followup stays contextual and cannot issue commands');
      }
      assert.equal(events.filter(e=>e.kind==='assistant').length,1);assert.deepEqual(choices,[]);
      return;
    }
    assert.ok(polls.some(p=>p.nativeQuestionId===card.id && !p.ready));
    assert.deepEqual(choices,[]);
    if(scenario==='failed before choice')item.nativeQuestion={...card,status:'failed'};
    deliver=true;await tick();await tick();
    if (scenario==='verification before selection confirmation') {
      now+=60000;await tick();
      verification=false;notify();await tick();
      now+=4000;await tick();
      assert.equal(events.some(e=>['uncertain','blocked'].includes(e.kind)),false);
      rows.push(item);
      item.nativeQuestion={...card,status:'answered',selected:'Indigo'};
      item.prose=item.text='Received Indigo.';item.complete=true;
      notify();now+=1800;await tick();await tick();
      assert.deepEqual(choices,['Indigo']);
      assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),['request-job','answer-job']);
      assert.deepEqual(events.filter(e=>e.kind==='assistant'&&!e.nativeQuestion).map(e=>e.text),['Received Indigo.']);
      return;
    }
    if(!comparison&&!['selected','summary then reply','prose beside summary','confirmation lost'].includes(scenario)){
      assert.deepEqual(choices,[]);
      assert.deepEqual(events.filter(e=>e.kind==='blocked').map(e=>e.job),['answer-job']);
      return;
    }
    assert.deepEqual(choices,['Indigo']);
    if(scenario==='summary then reply'){
      now+=2000;notify();await tick();
      assert.equal(events.filter(e=>e.kind==='assistant'&&!e.nativeQuestion).length,0,'summary alone acknowledges the choice, not the following reply');
      rows.push({role:'assistant',siteId:'chat-message-result',nativeMessage:true,text:'Received Indigo.',complete:true});
    } else if(scenario==='confirmation lost'){
      item.nativeQuestion=null;item.prose='';item.text='';now+=125000;
      notify();await tick();await tick();
      assert.deepEqual(events.filter(e=>e.kind==='blocked').map(e=>e.job),['answer-job']);return;
    } else {item.prose='Received Indigo.';item.text='Received Indigo.';item.complete=true;}
    notify();now+=1800;await tick();await tick();
    if (comparison) {now+=2000;await tick();await tick();}
    assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),['request-job','answer-job']);
    assert.deepEqual(events.filter(e=>e.kind==='assistant'&&!e.nativeQuestion).map(e=>e.text),['Received Indigo.']);
    assert.equal(events.filter(e=>e.nativeQuestion).length,1);
    if (comparison) {
      assert.equal(events.filter(e=>e.audio).length,0,'the already delivered tracks are not sent again after selection');
      now+=1000;await tick();
      assert.equal(polls.at(-1).ready,true);
    }
  });
}

for (const outcome of ['select and skip both panels','changed preview order','lazy previews','text question before images',
  'text question after images','voice panels','voice previews unavailable','voice playback required','voice source changes on retry']) {
  test('native galleries '+outcome,async()=>{
    const chat='https://arena.ai/agent/image-sequence', field={}, events=[], clicked=[];
    const rows=[{role:'user',text:'old'},{role:'assistant',text:'old answer',complete:true}];
    const voice=outcome.startsWith('voice');
    const broken=outcome==='voice previews unavailable';
    const playbackRequired=outcome==='voice playback required';
    const replaceAudio=outcome==='voice source changes on retry';
    const choiceField=voice?'audioChoices':'imageChoices', label=voice?'Voice Sample':'Image';
    const cards=[0,1].map(index=>({id:'chat-message-gallery/'+(voice?'voice':'image')+'-choice/'+(index+1),
      question:voice?'Which voice sample do you want to continue with?':'Which image do you prefer?',
      status:'active',options:[label+' 1',label+' 2','Skip'],sources:['/a'+index,'/b'+index],images:[{},{}],
      buttons:[{}, {disabled:playbackRequired&&index===0}, {}]}));
    const row={role:'assistant',nativeMessage:true,siteId:'chat-message-gallery',text:'Choose an image.',prose:'Choose an image.',
      complete:false,[choiceField]:[...cards]};
    const textCard={id:'chat-message-gallery',question:'Confirm?',options:['Yes'],status:'active'};
    if(outcome==='lazy previews') cards[0].status='loading';
    if(outcome==='text question before images') row.nativeQuestion=textCard;
    let listener, tick, notify, now=1000, offered=false, answer, ready, failedEvent;
    const ctx=vm.createContext({crypto,URL,location:{href:chat},Date:class extends Date{static now(){return now;}},
      document:{documentElement:{}},addEventListener(){},setInterval:fn=>tick=fn,
      MutationObserver:class{constructor(fn){notify=fn;}observe(){}},
      ArenaGeneratedImages:{async encode(card){return card.sources.map(data=>({mediaType:'image/png',data}));},
        activate(card){assert.equal(card.id,cards[0].id);cards[0].status='active';}},
      ArenaNativeQuestions:{async encodeAudio(card){
        if (broken) throw Error('Preview expired');
        return card.sources.map(data=>({mediaType:'audio/mpeg',data}));
      }},
      chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listener=fn},sendMessage:async message=>{
        const result={ok:true,supportsNativeQuestions:true,supportsImageChoices:true,supportsAudioChoices:true};
        if(message.type==='event'){
          const event=JSON.parse(JSON.stringify(message.event));events.push(event);
          if (replaceAudio && event.audio && !failedEvent) {
            failedEvent=event.id;
            rows.at(-1).audioArtifact.sources=['/changed-audio','/track-2'];
            return {ok:false,error:'temporary loopback failure'};
          }
          if(event.nativeQuestion) Object.assign(result,{nativeQuestionHandled:'interactive',
            nativeQuestionId:event.nativeQuestion.id,replyTo:event.replyTo});
        }
        if(message.type==='poll'){
          ready=message.ready;
          if(message.ready && !offered){offered=true;result.job={id:'gallery-request',text:'Generate comparison'};}
          else if(answer && message.nativeQuestionId===answer.nativeAnswer.id){result.job=answer;answer=null;}
        }
        return result;
      }}},
      ArenaPage:class{
        state(){return {field,ready:rows.length<4 || rows.at(-1).complete,idle:true,generating:false,value:''};}
        rows(){return rows.map(value=>({...value}));}
        async submit(job,draft,guard,click){assert.ok(guard());click();rows.push({role:'user',text:job.text,
          siteId:'chat-message-user',lastLine:job.text.split('\n').at(-1)});}
        selectImageChoice(choice, sources) {
          const index=cards.findIndex(card=>card.id===choice.id);
          assert.equal(JSON.stringify(sources),JSON.stringify(cards[index].sources));
          clicked.push([index,choice.answer]);
          row[choiceField][index]=choice.answer==='Skip' ? {id:choice.id,status:'skipped',sources:voice?[sources[0]]:sources}
            : {id:choice.id,status:'selected',sources:[sources[1]]};
          if(index===1 && outcome==='text question after images') row.nativeQuestion=textCard;
          notify();
        }
        async selectAudioChoice(choice,sources,guard){
          assert.ok(guard());
          if (choice.id===cards[0].id && cards[0].buttons[1].disabled) return false;
          this.selectImageChoice(choice,sources);
          return true;
        }
        selectNativeAnswer(choice) {
          assert.equal(choice.id,textCard.id);
          clicked.push(['text',choice.answer]);
          row.nativeQuestion={...textCard,status:'answered',selected:choice.answer};
          notify();
        }
      }});
    for (const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
    const send=msg=>new Promise(resolve=>listener(msg,{id:'test'},resolve));
    const prepared=await send({type:'prepare',chat});
    await send({type:'attach',chat,binding:'b1',pageKey:prepared.pageKey});
    await tick();await tick();rows.push(row);notify();
    const settle=async()=>{for(let index=0;index<4;index++){now+=1100;await tick();}};
    await settle();
    const questions=()=>events.filter(event=>event.nativeQuestion);
    const answerFor=(card,id,pick)=>({id,nativeAnswer:{id:card.id,question:card.question,options:card.options,answer:pick}});
    const before=outcome==='text question before images', after=outcome==='text question after images';
    if(before){
      assert.equal(questions().at(-1)?.nativeQuestion.id,textCard.id);
      answer=answerFor(textCard,'gallery-answer-before','Yes');await settle();
    }
    const previewField=voice?'choiceAudio':'choicePreviews';
    const imageEvents=()=>questions().filter(event=>event[previewField])
      .map(event=>[event.nativeQuestion.id,event.replyTo,event[previewField].map(media=>media.data)]);
    const first=[cards[0].id,before?'gallery-answer-before':'gallery-request',cards[0].sources];
    if (broken) {
      assert.ok(events.some(event=>event.kind==='assistant'&&event.replyTo==='gallery-request'&&
        event.text.includes('original Arena tab')));
      assert.equal(questions().length,0);
      row[choiceField]=cards.map(card=>({id:card.id,status:'skipped',sources:[card.sources[0]]}));
      row.complete=true;
      notify();await settle();
      assert.equal(ready,true);
      return;
    }
    assert.deepEqual(imageEvents(),[first]);
    answer=answerFor(cards[0],'gallery-answer-1',label+' 2');
    if(outcome==='changed preview order'){
      row.imageChoices[0]={...cards[0],sources:[...cards[0].sources].reverse()};notify();
      await settle();
      assert.deepEqual(clicked,[]);
      assert.equal(events.filter(event=>event.kind==='blocked'&&event.job==='gallery-answer-1').length,1);
      return;
    }
    await settle();
    if (playbackRequired) {
      assert.deepEqual(clicked,[]);
      assert.equal(events.filter(event=>event.kind==='busy'&&event.voicePlaybackRequired&&event.job==='gallery-answer-1').length,1);
      cards[0].buttons[1].disabled=false;
      notify();await settle();
    }
    assert.deepEqual(imageEvents(),[first,[cards[1].id,'gallery-answer-1',cards[1].sources]]);
    answer=answerFor(cards[1],'gallery-answer-2','Skip');
    await settle();
    if(after){
      assert.equal(questions().at(-1)?.nativeQuestion.id,textCard.id);
      answer=answerFor(textCard,'gallery-answer-after','Yes');await settle();
    }
    rows.push({role:'assistant',nativeMessage:true,siteId:'chat-message-final',text:voice?'':'Selection received.',complete:true,
      ...(voice?{audioArtifact:{players:[{},{}],sources:['/track-1','/track-2']}}:{})});
    notify();await settle();await settle();
    const selected=[[0,label+' 2'],[1,'Skip']];
    if(before) selected.unshift(['text','Yes']);
    if(after) selected.push(['text','Yes']);
    assert.deepEqual(clicked,selected);
    assert.deepEqual(events.filter(event=>event.kind==='sent').map(event=>event.job),[
      'gallery-request',...(before?['gallery-answer-before']:[]),'gallery-answer-1','gallery-answer-2',...(after?['gallery-answer-after']:[])]);
    const final=events.filter(event=>event.kind==='assistant'&&!event.nativeQuestion);
    if (replaceAudio) {
      assert.equal(final.length,2);
      assert.equal(final[1].id,failedEvent);
      assert.equal(final[1].audio,undefined);
      assert.match(final[1].text,/audio changed/i);
      assert.equal(ready,true);
      return;
    }
    assert.deepEqual(final.map(event=>[event.replyTo,event.text]),[[after?'gallery-answer-after':'gallery-answer-2',voice?'':'Selection received.']]);
    if (voice) {
      assert.deepEqual(final[0].audio.map(track=>track.data),['/track-1','/track-2']);
      assert.equal(ready,true,'the original binding becomes available for the next Desktop turn');
    }
  });
}
