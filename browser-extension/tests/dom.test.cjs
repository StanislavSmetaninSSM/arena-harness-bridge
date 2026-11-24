const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, on } = require('node:events');
const { createServer } = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function serveRawReplyFixture() {
  const assets = new Set(['/core.js','/generated-images.js','/native-questions.js','/raw-reply.js','/adapter.js']);
  return createServer((request,response) => {
    const url = new URL(request.url,'http://127.0.0.1');
    if (url.pathname === '/api/chat/fixture/events') {
      const scenario = url.searchParams.get('case');
      const id = scenario || 'fixture';
      const command = JSON.stringify({$harness:'tool_call',turn_id:'a'.repeat(32),name:'read',
        arguments:{filePath:'fixture.txt'}});
      let markdown = scenario ? 'Before\n\n\x60\x60\x60json\n' + command + '\n\x60\x60\x60\n\nAfter'
        : '## Stream fixture\n\nSecond part \u{1F9EA}';
      if (url.searchParams.has('edited')) markdown=markdown.replace('fixture.txt','changed.txt');
      const chunks = [
        {type:'start',messageId:id},
        {type:'text-start',id:'first'}, {type:'text-delta',id:'first',delta:markdown.slice(0,17)},
        {type:'text-end',id:'first'}, {type:'text-start',id:'second'},
        {type:'text-delta',id:'second',delta:markdown.slice(17)}, {type:'text-end',id:'second'},
        {type:'finish',messageMetadata:{nodeId:id,pending:false}},
      ];
      if (scenario==='interrupted' || scenario==='late-finish' && !url.searchParams.has('recovered')) chunks.pop();
      const records = chunks.map((data,seq_num)=>({seq_num,body:JSON.stringify({data})}));
      response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});
      response.end('event: batch\ndata: ' + JSON.stringify({records}) + '\n\n');
    } else if (request.url === '/agent/fixture') {
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      response.end(fs.readFileSync(path.join(__dirname,'raw-reply.html')));
    } else if (assets.has(request.url)) {
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
      response.end(fs.readFileSync(path.join(__dirname,'..',request.url.slice(1))));
    } else {
      response.writeHead(404).end();
    }
  });
}

for (const [fixture, description] of [
  ['fixture.html', 'sending, completion, PNG verification and draft protection'],
  ['batch.html', 'atomic ordered PNG uploads and upload rejection'],
  ['questions.html', 'native single-choice question controls and terminal widgets'],
  ['image-choices.html', 'native image choice previews and exact controls'],
  ['status-authority.html', 'standalone final tool frames after native status rows'],
  ['raw-reply.html', 'raw tool JSON and comparison of the native Copy with the live stream'],
  ['review.html', 'native feedback and safe recovery before Send']
]) test('isolated Chrome exercises ' + description, async () => {
  const chrome = process.env.CHROME_BIN || (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-bridge-fixture-'));
  let url = pathToFileURL(path.join(__dirname, fixture)).href;
  const server = fixture === 'raw-reply.html' ? serveRawReplyFixture() : null;
  if (server) {
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    url = 'http://127.0.0.1:' + server.address().port + '/agent/fixture';
  }
  const proc = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run',
    '--disable-background-networking','--disable-sync','--allow-file-access-from-files',
    '--user-data-dir='+profile,'--remote-debugging-port=0',url],{stdio:'ignore',windowsHide:true});
  let launchError;
  const exited = once(proc,'exit').catch(error=>{ launchError=error; });
  let socket;
  try {
    const signal=AbortSignal.timeout(30000);
    const portFile=path.join(profile,'DevToolsActivePort');
    let target;
    while (!target) {
      await delay(50,undefined,{signal});
      if (launchError) throw launchError;
      assert.equal(proc.exitCode,null,'isolated Chrome exited before opening the fixture');
      if (!fs.existsSync(portFile)) continue;
      const port=fs.readFileSync(portFile,'utf8').split(/\r?\n/)[0];
      const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal})).json();
      target=tabs.find(tab=>tab.type==='page' && tab.url===url);
    }
    socket=new WebSocket(target.webSocketDebuggerUrl);
    await once(socket,'open',{signal});
    const replies=on(socket,'message',{signal});
    try {
      for(let id=1;;id++) {
        socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{
          expression:"document.querySelector('#out')?.textContent",returnByValue:true
        }}));
        let answer;
        do { answer=JSON.parse((await replies.next()).value[0].data); } while(answer.id!==id);
        // Chrome can expose the target before the fixture's document has committed.
        if(answer.error && !/context/i.test(answer.error.message)) throw Error(answer.error.message);
        const status=answer.result?.result?.value;
        if(status && status!=='running' && !status.startsWith('Passed ')) {
          assert.equal(status,'All fixture checks passed');
          break;
        }
        await delay(80,undefined,{signal});
      }
    } finally { await replies.return(); }
  } finally {
    try {
      if (socket?.readyState===WebSocket.OPEN) {
        socket.send(JSON.stringify({id:2,method:'Browser.close'}));
        socket.close();
      } else if (proc.pid) proc.kill();
      await exited;
    } finally {
      if (server) await new Promise(resolve=>server.close(resolve));
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});
