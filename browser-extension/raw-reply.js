'use strict';

// The site's Copy action receives its Markdown before it is rendered.
// Run in the page world so the synchronous write can be captured locally.
(() => {
  const maxReplyLength = 180000;
  const maxEventLength = 1024 * 1024;
  // A cloned stream can read ahead of Arena. Bound that backlog separately
  // from parser state so ordinary long-lived connections can carry many turns.
  const maxCloneBytes = 16 * 1024 * 1024;
  const maxSavedReplies = 8;
  const replies = new Map();
  let chatPath;
  let readers = 0;

  function currentChat() {
    const path = /^\/agent\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname)?.[1];
    if (path !== chatPath) {
      replies.clear();
      chatPath = path;
    }
    return path;
  }

  function replyEntry(id) {
    if (!replies.has(id)) {
      if (replies.size === maxSavedReplies) replies.delete(replies.keys().next().value);
      replies.set(id,{streams:new Map(),pending:new Map(),settled:undefined,epoch:0,interruptedAt:0});
    }
    return replies.get(id);
  }

  function rememberReply(id, text, observation) {
    const reply = replies.get(id);
    const epoch = reply?.pending.get(observation);
    if (!epoch) return;
    const {streams,pending} = reply;
    pending.delete(observation);
    const previous = streams.get(observation);
    streams.set(observation,{text:!previous || previous.text === text ? text : null,epoch});
  }

  function finishObservation(observation, valid) {
    for (const reply of replies.values()) {
      const unfinished = reply.pending.get(observation);
      if (unfinished) {
        reply.pending.delete(observation);
        reply.interruptedAt = Math.max(reply.interruptedAt,unfinished);
      }
      const proof = reply.streams.get(observation);
      if (!reply.streams.delete(observation)) continue;
      if (valid && !unfinished) {
        const settled = reply.settled;
        reply.settled = {text:!settled || settled.text === proof.text ? proof.text : null,
          epoch:Math.max(settled?.epoch ?? 0,proof.epoch)};
      }
    }
  }

  function readReplyEvents(observation) {
    const records = new Map();
    let highest, turn, buffer = '', skipLF = false, type = '', data = [], dataLength = 0, recordsLength = 0;

    function record(entry) {
      const seq = entry?.seq_num;
      if (!Number.isSafeInteger(seq) || seq < 0) throw Error('Invalid Arena sequence');
      const serialized = JSON.stringify(entry);
      if (records.has(seq)) {
        if (records.get(seq) !== serialized) throw Error('Conflicting Arena sequence');
        return;
      }
      if (seq <= highest) throw Error('Out-of-order Arena sequence');
      if (seq !== highest + 1) turn = undefined;
      if (serialized.length > maxEventLength) throw Error('Oversized Arena record');
      while (recordsLength + serialized.length > maxEventLength) {
        const first = records.keys().next().value;
        recordsLength -= records.get(first).length;
        records.delete(first);
      }
      records.set(seq,serialized);
      recordsLength += serialized.length;
      highest = seq;

      if (typeof entry.body !== 'string' || entry.headers?.some(([key,value]) => key === '' && value === 'trim')) {
        turn = undefined;
        return;
      }
      const chunk = JSON.parse(entry.body)?.data;
      const kind = chunk?.type;
      if (kind === 'start') {
        turn = typeof chunk.messageId === 'string' && chunk.messageId
          ? {id:chunk.messageId,parts:new Map(),length:0,recordsLength:serialized.length} : undefined;
        if (turn) {
          const reply = replyEntry(turn.id);
          reply.pending.set(observation,++reply.epoch);
        }
        return;
      }
      if (!turn) return;
      turn.recordsLength += serialized.length;
      if (typeof kind !== 'string' || turn.recordsLength > maxEventLength) {
        turn = undefined;
        return;
      }
      if (kind === 'finish') {
        const parts = [...turn.parts.values()];
        if (chunk.messageMetadata?.nodeId === turn.id && chunk.messageMetadata.pending === false &&
            parts.length && parts.every(part=>part.ended)) {
          rememberReply(turn.id,parts.map(part=>part.text).join(''),observation);
        }
        turn = undefined;
      } else if (kind === 'abort' || kind === 'error') {
        turn = undefined;
      } else if (kind === 'text-start') {
        if (typeof chunk.id !== 'string' || !chunk.id || turn.parts.has(chunk.id)) turn = undefined;
        else turn.parts.set(chunk.id,{text:'',ended:false});
      } else if (kind === 'text-delta' || kind === 'text-end') {
        const part = turn.parts.get(chunk.id);
        if (!part || part.ended) turn = undefined;
        else if (kind === 'text-end') part.ended = true;
        else if (typeof chunk.delta !== 'string' || turn.length + chunk.delta.length > maxReplyLength)
          turn = undefined;
        else {
          part.text += chunk.delta;
          turn.length += chunk.delta.length;
        }
      }
    }

    function readLine(line) {
      if (line.length > maxEventLength) throw Error('Oversized Arena event line');
      if (!line) {
        if (type === 'batch' && data.length) {
          const entries = JSON.parse(data.join('\n')).records;
          if (!Array.isArray(entries)) throw Error('Invalid Arena batch');
          for (const entry of entries) record(entry);
        }
        type = '';
        data = [];
        dataLength = 0;
      } else if (line.startsWith('event:')) type = line.slice(6).replace(/^ /,'');
      else if (line.startsWith('data:')) {
        dataLength += line.length;
        if (dataLength > maxEventLength) throw Error('Oversized Arena event');
        data.push(line.slice(5).replace(/^ /,''));
      }
    }

    return function readText(text) {
      if (!text) return;
      if (skipLF && text.startsWith('\n')) text = text.slice(1);
      skipLF = text.endsWith('\r');
      const input = buffer + text;
      let offset = 0;
      for (const newline of input.matchAll(/\r\n?|\n/g)) {
        readLine(input.slice(offset,newline.index));
        offset = newline.index + newline[0].length;
      }
      buffer = input.slice(offset);
      if (buffer.length > maxEventLength) throw Error('Oversized Arena event line');
    };
  }

  async function observe(response, chat) {
    if (readers >= 2 || currentChat() !== chat || !response.ok || response.redirected ||
        !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) return;
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder('utf-8',{fatal:true});
    const observation = {};
    const readText = readReplyEvents(observation);
    let bytes = 0, valid = true;
    readers++;
    try {
      while (currentChat() === chat) {
        const next = await reader.read();
        if (currentChat() !== chat) break;
        bytes += next.value?.byteLength ?? 0;
        if (bytes > maxCloneBytes) break;
        try {
          readText(decoder.decode(next.value,{stream:!next.done}));
        } catch {
          valid = false;
          break;
        }
        if (next.done) break;
      }
    } finally {
      readers--;
      finishObservation(observation,valid);
      // Cancel only the diagnostic branch. The page can continue reading its own body.
      void reader.cancel().catch(()=>{});
    }
  }

  function observeFetch() {
    const fetch = window.fetch;
    window.fetch = function(input, init) {
      const promise = Reflect.apply(fetch,this,arguments);
      try {
        const chat = currentChat();
        if (chat) {
          const request = input instanceof Request ? input : null;
          const method = init?.method ?? request?.method ?? 'GET';
          const url = new URL(request ? request.url : input,location.href);
          if (url.origin === location.origin && url.pathname === '/api/chat/' + chat + '/events' &&
              String(method).toUpperCase() === 'GET') {
            void promise.then(response=>observe(response,chat)).catch(()=>{});
          }
        }
      } catch {}
      return promise;
    };
  }

  let capturingReply = false;
  let clickingCopy = false;
  function readCopy(row, submitted = false) {
    if (capturingReply) return;
    const content = '.prose,.markdown,[data-message-content],[data-testid="message-content"],pre,code,blockquote,details,form,[contenteditable],[inert],[aria-hidden="true"]';
    const buttons = Array.from(row.querySelectorAll('button[aria-label="Copy" i]')).filter(button =>
      button.closest('[id^="chat-message-"]') === row && !button.closest(content) && !button.matches(':disabled,[aria-disabled="true"]') &&
      button.checkVisibility({checkOpacity:!submitted,checkVisibilityCSS:true}));
    if (buttons.length !== 1 || !navigator.clipboard) return;
    const clipboard = navigator.clipboard;
    const previous = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
    const previousWrite = submitted ? Object.getOwnPropertyDescriptor(clipboard, 'write') : undefined;
    const previousCommand = submitted ? Object.getOwnPropertyDescriptor(document, 'execCommand') : undefined;
    const originalChildren = submitted ? new Set(document.body.children) : null;
    const written = [];
    let legacyInstalled = false, writeInstalled = false;
    const restore = () => {
      if (previous) Object.defineProperty(clipboard, 'writeText', previous);
      else delete clipboard.writeText;
      if (writeInstalled) {
        if (previousWrite) Object.defineProperty(clipboard, 'write', previousWrite);
        else delete clipboard.write;
      }
      if (legacyInstalled) {
        if (previousCommand) Object.defineProperty(document, 'execCommand', previousCommand);
        else delete document.execCommand;
      }
      capturingReply = false;
    };
    try {
      Object.defineProperty(clipboard, 'writeText', {
        configurable:true,
        value:async text => { if (typeof text === 'string') written.push(text); }
      });
    } catch { return; }
    if (submitted) {
      try {
        // Unrecognized ClipboardItem writes fail closed without touching the clipboard.
        Object.defineProperty(clipboard, 'write', {configurable:true,value:async()=>{written.push(null);}});
        writeInstalled = true;
        Object.defineProperty(document, 'execCommand', {
          configurable:true,
          value: command => {
            if (command !== 'copy') return false;
            // Arena's legacy Copy selects a newly attached, single-text span.
            // Read that exact text and never execute the system copy command.
            const selection = document.getSelection();
            const span = selection?.anchorNode;
            if (!(span instanceof HTMLSpanElement) || span.parentElement !== document.body ||
                originalChildren.has(span) || span.childNodes.length !== 1 ||
                span.firstChild.nodeType !== Node.TEXT_NODE || selection.rangeCount !== 1 ||
                selection.focusNode !== span) return false;
            const range = selection.getRangeAt(0);
            if (range.startOffset !== 0 || range.endOffset !== 1) return false;
            written.push(span.textContent);
            return true;
          }
        });
        legacyInstalled = true;
      } catch { restore(); return; }
    }
    capturingReply = true;
    clickingCopy = true;
    try {
      buttons[0].click();
    } finally {
      clickingCopy = false;
      // Only an immediate Copy is a source. Keep the stub through the first
      // microtask if an updated control defers the write instead.
      if (written.length) restore();
      else queueMicrotask(restore);
    }
    if (written.length === 1 && typeof written[0] === 'string' && written[0].length <= maxReplyLength) return written[0];
  }

  function visibleReplies() {
    const message = '[data-agent-transcript-message="true"][id^="chat-message-"]';
    // Arena can keep the previous conversation mounted after changing routes.
    return Array.from(document.querySelectorAll(message)).filter(row =>
      row.getClientRects().length && row.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  }

  function captureReply(event) {
    const row = event.target;
    const messages = visibleReplies();
    const submitted = event.type === 'arena-harness-check-submitted';
    const streamHistory = event.type === 'arena-harness-check-stream';
    const historical = submitted || streamHistory || event.type === 'arena-harness-check-history';
    const streamOnly = streamHistory || event.type === 'arena-harness-confirm-stream';
    const copyOnly = submitted || event.type === 'arena-harness-check-history' || event.type === 'arena-harness-confirm-copy';
    const path = currentChat();
    if (clickingCopy || typeof event.detail !== 'string' || !/^[a-f0-9-]{36}$/.test(event.detail) ||
        !(row instanceof HTMLElement) || !messages.includes(row) ||
        !historical && row !== messages.at(-1) ||
        row.id !== 'chat-message-' + row.dataset.chatMessageId) return;
    const id = row.dataset.chatMessageId;
    const identities = [row.id,row.dataset.chatMessageId,row.dataset.messageId].filter(Boolean).map(CSS.escape);
    const selector = identities.map(id => '#'+id+',[data-chat-message-id="'+id+'"],[data-message-id="'+id+'"]').join(',');
    if (document.querySelectorAll(selector).length !== 1) return;

    const reply = replies.get(id);
    const candidates = reply ? [reply.settled,...reply.streams.values()].filter(Boolean) : [];
    const stream = candidates[0]?.text;
    const conflict = candidates.some(proof=>proof.text === null || proof.text !== stream);
    const incomplete = reply && (reply.pending.size || !candidates.some(proof=>proof.epoch > reply.interruptedAt));
    let result;
    if ((!historical || streamOnly) && conflict) result = {status:'conflict'};
    else if ((!historical || streamOnly) && incomplete) result = {status:'incomplete'};
    else if (!copyOnly && typeof stream === 'string') result = {source:stream,origin:'stream'};
    else if (streamOnly) result = {status:'unobserved'};
    else {
      const copy = readCopy(row, submitted);
      if (copy !== undefined) result = {source:copy,origin:'copy'};
    }
    const latest = visibleReplies();
    if (path !== currentChat() || !row.isConnected || !latest.includes(row) ||
        !historical && row !== latest.at(-1) ||
        row.dataset.chatMessageId !== id || row.id !== 'chat-message-' + id ||
        document.querySelectorAll(selector).length !== 1) return;
    if (result) {
      row.dispatchEvent(new CustomEvent('arena-harness-reply-source', {
        detail:JSON.stringify({nonce:event.detail,...result})
      }));
    }
  }
  for (const action of ['read-reply','check-history','check-submitted','check-stream','confirm-stream','confirm-copy'])
    document.addEventListener('arena-harness-'+action,captureReply);
  try { observeFetch(); } catch {}
})();
