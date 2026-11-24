'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: nextTick } = require('node:timers/promises');

const script = fs.readFileSync(path.join(__dirname, '..', 'raw-reply.js'), 'utf8');
const chat = '01a208ba-6a97-7f33-a43b-54e243e46e49';
const otherChat = '01a208d3-6a49-73de-a589-80689e7ad929';
const message = '01a20904-1504-7264-b526-dfefcb99e51a';
const endpoint = '/api/chat/' + chat + '/events';
const raw = '## Markdown 🪜\n\n```json\n' + String.raw`{"path":"D:\\Arena\\probe.txt","quote":"\"demo\""}` + '\n```';

const event = (seq_num, type, fields = {}) => ({seq_num, body:JSON.stringify({data:{type,...fields}})});
const start = (id = message) => event(10, 'start', {messageId:id});
const begin = (seq, id = 'part') => event(seq, 'text-start', {id});
const delta = (seq, text, id = 'part') => event(seq, 'text-delta', {id,delta:text});
const end = (seq, id = 'part') => event(seq, 'text-end', {id});
const finish = (seq, id = message) => event(seq, 'finish', {messageMetadata:{nodeId:id,pending:false}});
const records = [start(), begin(11), delta(12,raw), end(13), finish(14)];
const batch = (items, newline = '\n') => 'event: batch' + newline + 'data: ' +
  JSON.stringify({records:items}) + newline + newline;

function fixture() {
  const listeners = new Map();
  let copyClicks = 0;
  let sent, response, clipboardWrites = 0, fetchCalls = 0, source = raw;
  const location = new URL('https://arena.ai/agent/' + chat);
  const clipboard = {writeText: async () => { clipboardWrites++; }};
  class Row {
    id = 'chat-message-' + message;
    dataset = {chatMessageId:message};
    isConnected = true;
    getClientRects() { return [{}]; }
    checkVisibility() { return true; }
    querySelectorAll() {
      return [{
        closest: selector => selector === '[id^="chat-message-"]' ? this : null,
        matches: () => false,
        checkVisibility: () => true,
        click: () => { copyClicks++; return clipboard.writeText(source); },
      }];
    }
    dispatchEvent(event) { sent = JSON.parse(event.detail); }
  }
  const row = new Row();
  const native = function() { fetchCalls++; return response; };
  const window = {fetch:native};
  vm.runInNewContext(script, {
    window, location, URL, Request, TextDecoder, queueMicrotask,
    HTMLElement:Row, navigator:{clipboard}, CSS:{escape:id=>id}, CustomEvent,
    document:{
      querySelectorAll:()=>[row],
      addEventListener:(name,listener)=>listeners.set(name,listener),
    },
    console,
  });
  function copy(text = raw, history = false, expected = history ? 'copy' : 'stream') {
    const clicks = copyClicks;
    sent = undefined;
    source = text;
    listeners.get(history ? 'arena-harness-check-history' : 'arena-harness-read-reply')({
      target:row, detail:message, type:history ? 'arena-harness-check-history' : 'arena-harness-read-reply',
    });
    const evidence = expected === 'conflict' || expected === 'incomplete'
      ? {status:expected} : {source:text,origin:expected};
    assert.deepEqual(sent,{nonce:message,...evidence});
    assert.equal(clipboardWrites,0);
    assert.equal(copyClicks-clicks, expected === 'copy' ? 1 : 0);
    return sent.origin ?? sent.status;
  }
  async function read(text, {url = endpoint, mime = 'text/event-stream; charset=utf-8',
    chunkSize = 4096, open = false, error = false, method = 'GET'} = {}) {
    const bytes = new TextEncoder().encode(text);
    let controller;
    const body = new ReadableStream({
      start(stream) {
        controller = stream;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          stream.enqueue(bytes.slice(offset,offset + chunkSize));
        }
        if (!open && !error) stream.close();
      },
    });
    const original = new Response(body,{headers:{'content-type':mime}});
    response = Promise.resolve(original);
    const called = fetchCalls;
    const actual = window.fetch(url,{method});
    assert.equal(actual,response,'the page receives the original Promise');
    assert.equal(fetchCalls,called + 1,'no extra fetch');
    assert.equal(await actual,original,'the page receives the original Response');
    if (open || error) {
      const reader = original.body.getReader();
      assert.equal((await reader.read()).done,false);
      if (error) controller.error(new Error('network interrupted'));
      await nextTick();
      await nextTick();
      return () => { controller.close(); reader.releaseLock(); };
    }
    assert.equal(await original.text(),text);
    await nextTick();
    await nextTick();
  }
  return {copy,read,location};
}

test('compares a complete reply while fetch is still open, including split UTF-8 and CRLF', async () => {
  const page = fixture();
  const close = await page.read(batch(records,'\r\n'),{chunkSize:7,open:true});
  try {
    assert.equal(page.copy(),'stream');
    assert.equal(page.copy(raw.replace('probe.txt','changed.txt'),true),'copy');
  } finally { close(); }
});

test('assembles multiple parts in opening order and ignores exact repeated records', async () => {
  const page = fixture();
  const parts = [
    start(), begin(11,'first'), begin(12,'second'), delta(13,raw,'second'),
    delta(14,'Explanation\n\n','first'), end(15,'first'), end(16,'second'), finish(17),
  ];
  await page.read(batch(parts.slice(0,5)) + batch(parts.slice(2)));
  assert.equal(page.copy('Explanation\n\n' + raw),'stream');
});

test('a late start or a broken sequence never makes a complete reply', async () => {
  for (const events of [records.slice(1), records.filter(record=>record.seq_num!==12),
    [start(), begin(11), delta(12,raw), finish(13)],
    [start(), begin(11), delta(12,raw), end(13), finish(14,otherChat)],
    [start(), begin(11), {seq_num:12}, delta(13,raw), end(14), finish(15)],
    [start(), begin(11), {seq_num:12,body:'{}'}, delta(13,raw), end(14), finish(15)]]) {
    const page = fixture();
    await page.read(batch(events));
    assert.equal(page.copy(raw,false,events[0] === records[1] ? 'copy' : 'incomplete'),events[0] === records[1] ? 'copy' : 'incomplete');
  }
});

test('conflicting replay removes the affected observation', async () => {
  const page = fixture();
  await page.read(batch(records) + batch([delta(12,'a different record at the same sequence')]));
  assert.equal(page.copy(raw,false,'incomplete'),'incomplete');
});

test('a valid independent observation survives a reader with an inconsistent replay', async () => {
  const page = fixture();
  const bad = delta(12,'Invalidated text');
  await page.read(batch(records));
  await page.read(batch([start(),begin(11),bad,end(13),finish(14)]) + batch([records[2]]));
  assert.equal(page.copy(),'stream');
});

test('a later response on the same long-lived connection remains observable', async () => {
  const page = fixture();
  const envelope = 'event: ping\ndata: ' + JSON.stringify({heartbeat:' '.repeat(64 * 1024)}) + '\n\n';
  await page.read(envelope.repeat(18) + batch(records),{chunkSize:65536});
  assert.equal(page.copy(),'stream');
});

test('the cloned read-ahead is bounded and Copy still works after the limit', async () => {
  const page = fixture();
  const envelope = 'event: ping\ndata: ' + JSON.stringify({heartbeat:' '.repeat(64 * 1024)}) + '\n\n';
  await page.read(envelope.repeat(257) + batch(records),{chunkSize:65536});
  assert.equal(page.copy(raw,false,'copy'),'copy');
});

test('an interrupted stream is separate from reconnect, and a fresh full replay can match', async () => {
  const page = fixture();
  await page.read(batch(records.slice(0,3)),{error:true});
  assert.equal(page.copy(raw,false,'incomplete'),'incomplete');
  await page.read(batch(records.slice(3)));
  assert.equal(page.copy(raw,false,'incomplete'),'incomplete');
  await page.read(batch(records));
  assert.equal(page.copy(),'stream');
});

test('an incomplete replay of the same ID cannot revive an older completed response', async () => {
  const page = fixture();
  await page.read(batch(records));
  await page.read(batch([start(),begin(11),delta(12,'Unfinished new reply')]));
  assert.equal(page.copy(raw,false,'incomplete'),'incomplete');
  await page.read(batch(records));
  assert.equal(page.copy(),'stream');
});

test('a new source with the same native ID and different text reports a conflict even if Copy agrees', async () => {
  const page = fixture();
  await page.read(batch(records));
  const changed = raw + '\nAltered answer';
  await page.read(batch([start(),begin(11),delta(12,changed),end(13),finish(14)]));
  assert.equal(page.copy(changed,true),'copy');
  assert.equal(page.copy(changed,false,'conflict'),'conflict');
});

test('wrong route, method and media type stay unobserved', async () => {
  const page = fixture();
  await page.read(batch(records),{url:'/api/chat/' + otherChat + '/events'});
  await page.read(batch(records),{url:'https://example.test' + endpoint});
  await page.read(batch(records),{method:'POST'});
  await page.read(batch(records),{mime:'application/json'});
  await page.read(batch([start(otherChat),begin(11),delta(12,raw),end(13),finish(14,otherChat)]));
  assert.equal(page.copy(raw,false,'copy'),'copy');
  await page.read(batch(records));
  page.location.pathname = '/agent/' + otherChat;
  assert.equal(page.copy(raw,false,'copy'),'copy');
});
