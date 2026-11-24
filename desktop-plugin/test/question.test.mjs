import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { register } from '../../harness-adapter/node_modules/tsx/dist/esm/api/index.mjs'

register({ tsconfig: fileURLToPath(new URL('../../deepseek-harness/tsconfig.json', import.meta.url)) })

// Simulate only the bound browser's input and response events. Use the real Desktop
// journal and its frame parser, including duplicate delivery of the browser event.
const browserTurn = `
import json, sys
from pathlib import Path
from arena_terminal.desktop_provider import DesktopJournal

root = Path(sys.argv[1])
request, answer, marked, card, open_card_id, previews = json.load(sys.stdin)
db = DesktopJournal(root / "journal.sqlite", root)
try:
    db.pair_owner(request["sessionId"])
    chat = "https://arena.ai/agent/question-fixture"
    existing = db.one("SELECT id FROM binding")
    addr = dict(chat=chat, tab=3, binding=existing["id"] if existing else db.bind(chat, 3))
    rid = db.start(request)["id"]
    if request.get("galleryAnswer"):
        # Lose the start ACK after commit, before the browser leases the click.
        db.close()
        db = DesktopJournal(root / "journal.sqlite", root)
        if db.start(request)["id"] != rid:
            raise AssertionError("A retried native answer created a second delivery")
    if previews and [tool["name"] for tool in request["tools"]] == ["run_code"]:
        if db.start(dict(request, galleryViaCode=not request.get("galleryViaCode")))["id"] != rid:
            raise AssertionError("Replaying a start changed the gallery's original admission")
    poller = dict(addr, supportsNativeQuestions=True, nativeQuestionId=open_card_id)
    job = db.poll(poller, open_card_id is None)
    db.event(dict(addr, id="sent-" + rid, kind="sent", job=job["id"]))
    if marked:
        answer = answer.replace("CURRENT_DELIVERY_ID", job["id"])
    reply = dict(addr, id="answer-" + rid, kind="assistant", text=answer,
                 toolFrame=marked, replyTo=job["id"])
    if card is not None:
        reply.update(nativeQuestion=card, supportsNativeQuestions=True, replyTo=job["id"])
    if previews is not None:
        reply["choicePreviews"] = previews
    db.event(reply)
    db.event(reply)
    db.close()
    db = DesktopJournal(root / "journal.sqlite", root)
    if db.start(request)["id"] != rid or db.poll(poller, True) is not None:
        raise AssertionError("Replaying the start after reconnect created another browser turn")
    print(json.dumps([db.status(rid, request["sessionId"]), job.get("nativeAnswer")]))
finally:
    db.close()
`

test('a bound Arena question reaches the native answerer once and only its owning request receives the selection', {timeout:15000}, async t => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { ArenaAdapter } = await import('../provider.mjs')
  const root = await mkdtemp(join(tmpdir(),'arena-native-question-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  for (const service of ['llm','session','session-projection','system-prompt','tools','agent','user-questions']) {
    await ctx.plugin((await import('@deepseek-ai/dsh-' + service)).default)
  }
  await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
  await ctx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default,{agents:[]})
  await ctx.plugin(await import('@deepseek-ai/dsh-tool-ask-user'))
  await ctx.plugin((await import('@deepseek-ai/dsh-attachment-local')).default, {dshHome:root})

  const question = {id:'focus_wordpad',header:'Фокус окна',question:'Как продолжить работу с окном?',options:[
    {label:'Готово',description:'Окно уже активно.'}, {label:'Попробовать снова'}, {label:'Отмена'},
  ]}
  const command = JSON.stringify({
    $harness:'tool_call',turn_id:'CURRENT_DELIVERY_ID',name:'ask_user_question',arguments:{questions:[question]},
  })
  const frame = '```json\n' + command + '\n```'
  const explanation = 'Уточню, как продолжить работу с окном.'
  const markedQuestion = explanation + '\n\n' + frame
  const example = 'Пример вызова инструмента.\n\n```text\n' + command + '\n```'
  const card = {id:'arena-native-card',question:question.question,options:question.options.map(option => option.label)}
  const gallery = {id:'arena-gallery',question:'Which image do you prefer?',options:['Image 1','Image 2','Skip']}
  const previews = [
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
  ].map(data => ({mediaType:'image/png',data}))
  let openCard
  const cardAnswers = []
  const starts = []
  const statuses = new Map()
  const peer = {async rpc(method,params) {
    if (method === 'setup') return {supportsResultView:true,supportsOnDemandContext:true}
    if (method === 'status') return statuses.get(params.id)
    assert.equal(method,'start')
    starts.push(params)
    const asks = !params.toolResult
    const isCard = params.text === 'Вопрос в карточке Arena'
    const isGallery = params.text === 'Выбор изображения Arena'
    const currentCard = isGallery ? gallery : isCard ? card : null
    const isExample = params.text === 'Покажи JSON вызова как пример'
    const output = execFileSync(process.env.ARENA_PYTHON || 'python',['-c',browserTurn,root],{
      cwd:fileURLToPath(new URL('../../',import.meta.url)), encoding:'utf8', windowsHide:true,
      input:JSON.stringify([params,currentCard ? currentCard.question : isExample ? example : asks ? markedQuestion : 'Ответ получен.',
        asks && !currentCard && !isExample,currentCard,openCard,isGallery ? previews : null]),
      env:{...process.env,PYTHONIOENCODING:'utf-8'},
    })
    const [status, nativeAnswer] = JSON.parse(output)
    if (currentCard) openCard = currentCard.id
    if (nativeAnswer) { cardAnswers.push(nativeAnswer); openCard = undefined }
    statuses.set(params.requestId,status)
    return {id:params.requestId}
  }}
  const adapter = new ArenaAdapter(ctx,peer,1)
  ctx.llm.registerAdapter(['arena'],adapter)
  const sessionId = 'question-session'
  const {agent} = await ctx.agents.create({sessionId,agentOptions:{provider:'arena',model:'agent-mode'}})

  let displayed = Promise.withResolvers()
  let submit
  const questions = []
  ctx.on('user-questions/request', async request => {
    questions.push(request)
    const answer = new Promise((resolve,reject) => {
      submit = resolve
      request.signal.addEventListener('abort',() => reject(request.signal.reason),{once:true})
    })
    displayed.resolve(request)
    return answer
  })
  const ask = async text => {
    displayed = Promise.withResolvers()
    agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}))
    return Promise.race([displayed.promise,agent.whenIdle().then(() => assert.fail('No native question reached the answerer'))])
  }
  const first = await ask('Первый вопрос')
  assert.equal(first.agent,agent)
  assert.deepEqual(first.questions,[question])
  const schema = starts[0].tools.find(tool => tool.name === 'ask_user_question').parameters
  assert.deepEqual(schema.properties.questions.items.required.toSorted(),['id','question'])
  assert.deepEqual(schema.properties.questions.items.properties.options.items.required,['label'])
  const answer = {answers:[{id:'focus_wordpad',selected:['Попробовать снова']}]}
  submit(answer)
  await agent.whenIdle()
  assert.equal(questions.length,1)
  assert.equal(starts.length,2)
  const result = JSON.parse(starts[1].toolResult)
  assert.equal(starts[1].sessionId,sessionId)
  assert.equal(result.toolCallId,'arena_' + starts[0].requestId)
  assert.equal(result.failed,false)
  assert.deepEqual(JSON.parse(result.text),answer)
  const history = agent.session.deriveMessages()
  const toolMessage = history.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))
  assert.deepEqual(toolMessage.content.map(block => block.type), ['text','tool-call'])
  assert.equal(toolMessage.content[0].text, explanation)
  assert.deepEqual(history.at(-1).content,[{type:'text',text:'Ответ получен.'}])
  await assert.rejects(adapter.request({sessionId:'other-session',messages:history.slice(0,-1)}),/original request and Desktop session/)

  const native = await ask('Вопрос в карточке Arena')
  assert.deepEqual(native.questions,[{id:card.id,question:card.question,options:card.options.map(label => ({label}))}])
  submit({answers:[{id:card.id,selected:['Отмена']}]})
  await agent.whenIdle()
  assert.deepEqual(cardAnswers,[{...card,answer:'Отмена'}])
  assert.equal(starts.length,4)

  agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Покажи JSON вызова как пример'}]}))
  await agent.whenIdle()
  assert.equal(questions.length,2)
  assert.equal(starts.length,5)
  assert.deepEqual(agent.session.deriveMessages().at(-1).content, [{type:'text',text:example}])

  const cancelled = await ask('Ещё один вопрос')
  agent.cancel({kind:'user'})
  await agent.whenIdle()
  assert.equal(cancelled.signal.aborted,true)
  assert.equal(questions.length,3)
  assert.equal(starts.length,6)

  const images = await ask('Выбор изображения Arena')
  const galleryMessage = agent.session.deriveMessages().findLast(row => row.role === 'assistant')
  assert.deepEqual(galleryMessage.content.map(block => block.type),['text','image','text','image','tool-call'])
  assert.deepEqual(galleryMessage.content.filter(block => block.type==='text').map(block=>block.text),['Image 1','Image 2'])
  assert.deepEqual(images.questions,[{id:gallery.id,question:gallery.question,options:gallery.options.map(label=>({label}))}])
  submit({answers:[{id:gallery.id,selected:['Image 2']}]})
  await agent.whenIdle()
  assert.deepEqual(cardAnswers.at(-1),{...gallery,answer:'Image 2'})
  assert.deepEqual(agent.session.deriveMessages().at(-1).content,[{type:'text',text:'Ответ получен.'}])
})

for (const mode of ['selected','partial','initialized','masked','revoked','revoked-after-open','native-revoked-after-open','cancelled']) {
  test('the PTC gallery keeps both previews and returns only a submitted native choice: '+mode, {timeout:30000}, async t => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const { ArenaAdapter } = await import('../provider.mjs')
    const root = await mkdtemp(join(tmpdir(),'arena-program-gallery-'))
    const ctx = new Context()
    t.after(async () => {await ctx.fiber.dispose(); await rm(root,{recursive:true,force:true})})
    for (const service of ['llm','session','session-projection','system-prompt','tools','agent','commands','user-questions']) {
      await ctx.plugin((await import('@deepseek-ai/dsh-'+service)).default)
    }
    await ctx.plugin((await import('@deepseek-ai/dsh-fs-local')).default,{cwd:root})
    for (const service of ['working-directory','subprocess-local','sandbox-local','sandbox-policy','ptc-runtime-node']) {
      const config = service==='sandbox-policy' ? {mode:'danger-full-access'} :
        service==='ptc-runtime-node' && mode==='initialized' ? {executionMode:'persistent-in-memory'} : {}
      await ctx.plugin((await import('@deepseek-ai/dsh-'+service)).default,config)
    }
    if (mode==='initialized') {
      const runtime = ctx.get('ptcRuntime')
      if (typeof runtime.registerEnvironmentInitializer !== 'function') {
        t.skip('This PTC runtime has no environment initializer')
        return
      }
      runtime.registerEnvironmentInitializer("console.log('Runtime ready')")
    }
    if (mode==='partial') {
      // Reproduce the Windows ACL runner's verdict while the real executor
      // still runs the program and renders both the selection and its advisory.
      const runtime = ctx.get('ptcRuntime')
      const run = runtime.run.bind(runtime)
      t.mock.method(runtime,'run',async spec=>({...await run(spec),sandbox:{mode:'workspace-write',denied:false,enforcement:'partial'}}))
    }
    const direct = mode==='native-revoked-after-open'
    await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-'+(direct ? 'native' : 'ptc')))
    await ctx.plugin((await import('@deepseek-ai/dsh-agent-loop')).default,{agents:[]})
    await ctx.plugin(await import('@deepseek-ai/dsh-tool-ask-user'))
    await ctx.plugin((await import('@deepseek-ai/dsh-attachment-local')).default,{dshHome:root})

    const gallery = {id:'card-"\n\\',question:'Pick "${a}"\n`quoted`? 🚀',options:['Image 1','Image 2','Skip']}
    const previews = [
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC',
    ].map(data => ({mediaType:'image/png',data}))
    const starts = [], answers = []
    const statuses = new Map()
    const peer = {async rpc(method,params) {
      if (method==='setup') return {supportsOnDemandContext:true,supportsResultView:true}
      if (method==='status') {
        if (mode==='revoked') await maskQuestion()
        return statuses.get(params.id)
      }
      assert.equal(method,'start')
      starts.push(params)
      const first = starts.length===1
      if (!first && mode==='selected') {
        const {Session} = await import('@deepseek-ai/dsh-session')
        const {session} = agent
        const events = session.snapshotEvents()
        const restored = Session.create(session.id,events,session.header,session.inheritedEventCount)
        const projection = await adapter.galleryProjection
        const recovered = projection.stateOf(restored)
        assert.equal(recovered.callId,params.galleryAnswer.callId)
        assert.deepEqual(JSON.parse(recovered.proof.text),{answers:[{id:gallery.id,selected:['Image 2']}]})
        const dispatch = events.findLast(event=>event.type==='tool/ptc-dispatch')
        restored.append('tool/ptc-dispatch',{...dispatch.data,subCallId:'second-dispatch'})
        assert.equal(projection.stateOf(restored).proof,null)
      }
      const input = [params,first ? gallery.question : 'Choice received.',false,
        first ? gallery : null,first ? null : gallery.id,first ? previews : null]
      const result = execFileSync(process.env.ARENA_PYTHON || 'python',['-c',browserTurn,root],{
        cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',windowsHide:true,
        input:JSON.stringify(input),env:{...process.env,PYTHONIOENCODING:'utf-8'},
      })
      const [status,answer] = JSON.parse(result)
      if (answer) answers.push(answer)
      statuses.set(params.requestId,status)
      return {id:params.requestId}
    }}
    const adapter = new ArenaAdapter(ctx,peer,1)
    ctx.llm.registerAdapter(['arena'],adapter)
    const {agent} = await ctx.agents.create({sessionId:'program-gallery',meta:{cwd:root},agentOptions:{provider:'arena',model:'agent-mode'}})
    const maskQuestion = () => agent.ctx.plugin({name:'mask-question',inject:['tools'],apply(owner) {
      owner.tools.restrict({deny:['ask_user_question']})
    }})
    if (mode==='masked') await maskQuestion()
    const displayed = Promise.withResolvers(), submitted = Promise.withResolvers()
    ctx.on('user-questions/request', async request => {
      displayed.resolve(request)
      request.signal.addEventListener('abort',()=>submitted.reject(request.signal.reason),{once:true})
      return submitted.promise
    })
    agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Show the gallery.'}]}))
    const idle = agent.whenIdle()
    const question = await Promise.race([displayed.promise,idle.then(()=>null)])
    const toolName = direct ? 'ask_user_question' : 'run_code'
    assert.deepEqual(starts[0].tools.map(tool=>tool.name),[toolName])
    const assistant = agent.session.deriveMessages().findLast(row=>row.role==='assistant')
    assert.equal(assistant.content.filter(block=>block.type==='image').length,2)
    if (mode==='masked' || mode==='revoked') {
      assert.equal(question,null)
      assert.equal(assistant.content.some(block=>block.type==='tool-call'),false)
      assert.match(assistant.content.filter(block=>block.type==='text').map(block=>block.text).join(' '),/Arena tab/i)
    } else {
      assert.ok(question,'No PTC gallery question reached the native answerer')
      assert.deepEqual(assistant.content.map(block=>block.type),['text','image','text','image','tool-call'])
      assert.equal(assistant.content.at(-1).name,toolName)
      assert.deepEqual(question.questions,[{id:gallery.id,question:gallery.question,options:gallery.options.map(label=>({label}))}])
      if (mode==='cancelled') agent.cancel({kind:'user'})
      else {
        if (mode.endsWith('revoked-after-open')) await maskQuestion()
        submitted.resolve({answers:[{id:gallery.id,selected:['Image 2']}]})
      }
    }
    await idle
    if (mode==='cancelled') assert.equal(question.signal.aborted,true)
    const answered = ['selected','partial','initialized'].includes(mode)
    assert.deepEqual(answers,answered ? [{...gallery,answer:'Image 2'}] : [])
    assert.equal(starts.length,answered ? 2 : 1)
    if (answered) assert.deepEqual(agent.session.deriveMessages().at(-1).content,[{type:'text',text:'Choice received.'}])
  })
}
