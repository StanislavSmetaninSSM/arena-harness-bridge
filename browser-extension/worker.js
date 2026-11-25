'use strict';
importScripts('core.js');

const defaultPort = 8766;
const reconnectBridge = 'Could not verify the local Arena bridge. Update the bridge and Chrome extension together. Get the current code from /arena-pair in Desktop or from the project terminal, then bind again.';

function pairing(code) {
  if (typeof code === 'string') {
    if (/^[A-Za-z0-9_-]+$/.test(code)) return { port: defaultPort, secret: code };
    const match = /^AHB1:([1-9][0-9]{0,4})→([A-Za-z0-9_-]+)$/.exec(code);
    if (match) {
      const port = Number(match[1]);
      if (port <= 65535 && port !== defaultPort) return { port, secret: match[2] };
    }
  }
  throw Error('Invalid pairing code. Copy the complete code from Desktop (/arena-pair) or the project terminal.');
}

function post(port, endpoint, body, bearer) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearer !== undefined) headers.Authorization = 'Bearer ' + bearer;
  return fetch(`http://127.0.0.1:${port}/v1/${endpoint}`, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(7000),
    headers, body: JSON.stringify(body)
  });
}

const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

async function verifiedBearer(port, secret) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  try {
    const response = await post(port, 'identity', { nonce });
    if (!response.ok) throw Error();
    const { instance, proof } = await response.json();
    if (typeof instance !== 'string' || !/^[0-9a-f]{32}$/.test(instance) ||
        typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) throw Error();
    const utf8 = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify', 'sign']);
    const signature = Uint8Array.from(proof.match(/../g), byte => parseInt(byte, 16));
    const challenge = utf8.encode(`arena-proof-v1|${port}|${instance}|${nonce}`);
    if (!await crypto.subtle.verify('HMAC', key, signature, challenge)) throw Error();
    return hex(await crypto.subtle.sign('HMAC', key, utf8.encode(`arena-auth-v1|${port}|${instance}`)));
  } catch { throw Error(reconnectBridge); }
}

async function request(code, endpoint, body) {
  const { port, secret } = pairing(code);
  const bearer = await verifiedBearer(port, secret);
  const response = await post(port, endpoint, body, bearer);
  const result = await response.json();
  if (!response.ok) {
    const error=Error(result.error || 'Terminal returned HTTP ' + response.status);
    if (response.status===400 && result.code==='arena-audio-rejected') error.audioRejected=true;
    throw error;
  }
  return result;
}

const address = link => ({ binding: link.binding, chat: link.chat, tab: link.tab });
const getLink = async () => (await chrome.storage.session.get('link')).link;
const save = link => chrome.storage.session.set({ link });

function mediaPayload(items, kind) {
  if (!Array.isArray(items) || !items.length || items.length > ArenaBridge.maxGeneratedImages)
    throw Error('Invalid generated '+kind+' count.');
  const types = kind==='image' ? ['image/png','image/jpeg','image/webp'] :
    ['audio/mpeg','audio/wav','audio/x-wav','audio/ogg','audio/mp4','audio/webm','audio/flac'];
  let bytes = 0;
  return items.map(({mediaType,data}) => {
    if (!types.includes(mediaType) || typeof data !== 'string'
        || !data.length || data.length % 4 || data.length > 11184812 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw Error('Invalid generated '+kind+' data.');
    bytes += data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > 8 * 1024 ** 2) throw Error('Generated '+(kind==='image'?'images':'audio')+' exceed the 8 MiB limit.');
    return {mediaType,data};
  });
}

async function tabMessage(tab, message) {
  let result;
  try { result = await chrome.tabs.sendMessage(tab, message, { frameId: 0 }); }
  catch { throw Error('Open the Agent Mode conversation and reload its tab after installing the extension.'); }
  if (!result?.ok) throw Error(result?.error || 'The Arena tab did not confirm the request.');
  return result;
}

async function pauseLink(link, reason) {
  delete link.checkDocument;
  link.paused = reason;
  if (link.receipt) {
    await save(link);
    await request(link.token, 'event', link.receipt);
    delete link.receipt;
    delete link.lease;
  }
  link.notice ??= link.lease ? ArenaBridge.event('uncertain', { job: link.lease, text: reason }) : ArenaBridge.event('busy', { text: reason });
  await save(link);
  await request(link.token, 'event', { ...link.notice, ...address(link) });
  delete link.notice;
  delete link.lease;
  await save(link);
}

const navigationNotice = 'Bound tab navigated or reloaded. Inspect the chat and reconnect.';
const awaitingDocument = 'Waiting for Chrome to confirm the bound conversation.';

async function documentProof(link, type='verifyDocument') {
  let timer;
  try {
    return await Promise.race([
      tabMessage(link.tab,{type,chat:link.chat,pageKey:link.pageKey,binding:link.binding}).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null),3000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function verifyTab(link, lastStatus, requireProof = false, returning = false) {
  const readTab = () => chrome.tabs.get(link.tab).catch(() => null);
  let tab = await readTab();
  const currentChat = () => ArenaBridge.conversation(tab?.url);
  const stable = currentChat() === link.chat && tab.status === 'complete' && !tab.pendingUrl && !tab.discarded;
  if (stable && !link.checkDocument && !requireProof && !link.away && !returning) return true;
  if (!stable && !link.checkDocument) { link.checkDocument = true; await save(link); }
  let proof;
  const initialStatus = tab?.status;
  if (!tab?.pendingUrl && currentChat() === link.chat && !tab.discarded) {
    proof = await documentProof(link,returning?'verifyReturn':'verifyDocument');
    tab = await readTab();
  }
  const chat = currentChat();
  if (tab?.url && chat !== link.chat) {
    if (!link.lease && !link.receipt && !link.notice && !tab.pendingUrl && !tab.discarded &&
        ArenaBridge.awayAgentRoute(link.chat,tab.url)) {
      const awayUrl=tab.url;
      const content=await documentProof(link,'parkRoute');
      tab=await readTab();
      if (tab?.url!==awayUrl || tab.pendingUrl) return false;
      if (!tab.discarded && content?.parked===true && content.chat===link.chat &&
          content.binding===link.binding && content.pageKey===link.pageKey) {
        if (!link.away) { link.away=true; await save(link); }
        return false;
      }
    }
    await pauseLink(link, navigationNotice);
    return false;
  }
  // Chrome can still deliver messages to the old document before a navigation commits.
  if (tab?.pendingUrl) return false;
  if (initialStatus !== tab?.status) return false;
  const complete = (tab?.status || lastStatus) === 'complete';
  if (chat === link.chat && !tab.discarded && proof?.pageKey === link.pageKey && proof.chat === link.chat && proof.binding === link.binding) {
    if (returning && (!complete || proof.returned!==true) || !returning && (proof.parked || link.away)) return false;
    if (complete && link.checkDocument) { delete link.checkDocument; await save(link); }
    return true;
  }
  if (complete && link.checkDocument) await pauseLink(link, navigationNotice);
  return false;
}

async function popup(message, link) {
  if (message.type === 'targets') {
    const tabs = await chrome.tabs.query({ url: ['https://arena.ai/*', 'https://www.arena.ai/*'] });
    return { targets: tabs.map(tab => ({ tab: tab.id, chat: ArenaBridge.conversation(tab.url) })).filter(item => item.chat) };
  }
  const tab = Number.isInteger(message.tab) && message.tab >= 0 ? await chrome.tabs.get(message.tab)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (message.type === 'status') {
    if (!link) return { status: 'Paste the pairing code from Desktop (/arena-pair) or the project terminal.' };
    if (link.paused) return { status: link.chat + '\n' + link.paused };
    const page = await tabMessage(link.tab, { type: 'status', pageKey: link.pageKey });
    return { status: link.chat + '\n' + page.status };
  }
  const chat = ArenaBridge.conversation(tab?.url);
  if (!chat) throw Error('Open one saved Arena Agent Mode conversation (/agent/<id>).');
  if (message.type === 'bind') {
    if (tab.pendingUrl) throw Error(awaitingDocument);
    if (!message.token?.trim()) throw Error('Enter the pairing code from Desktop or the project terminal.');
    const prepared = await tabMessage(tab.id, { type: 'prepare', chat });
    if (prepared.chat !== chat || !prepared.pageKey) throw Error('The Arena tab changed while pairing.');
    const token = message.token.trim();
    const settledDelivery = prepared.settledDelivery;
    const settlement = typeof settledDelivery === 'string' && /^[a-f\d]{32}$/.test(settledDelivery) ? {settledDelivery} : {};
    const result = await request(token, 'bind', { chat, tab: tab.id, ...settlement });
    if (typeof result.binding !== 'string' || !result.binding) throw Error('Invalid binding response.');
    const next = { token, tab: tab.id, chat, binding: result.binding, pageKey: prepared.pageKey };
    if (result.lease) {
      next.lease = result.lease;
      next.notice = { id:'rebind-' + result.binding + '-' + result.lease, kind:'uncertain',
        job:result.lease, text:'An offered delivery survived reconnect. Inspect it in the terminal.' };
      await save(next);
      await request(token,'event',{...next.notice,...address(next)});
      delete next.notice;
      delete next.lease;
    }
    await save(next);
    const reset = Boolean(link?.paused || link?.notice || link?.lease || result.lease);
    await tabMessage(tab.id, { type: 'attach', chat, pageKey: next.pageKey, binding: next.binding, context:result.context, reset });
    return { status: 'Connected to ' + chat };
  }
  if (message.type !== 'skill' || !link || link.paused || tab.id !== link.tab || chat !== link.chat)
    throw Error('Select the bound Arena conversation.');
  if (!await verifyTab(link)) throw Error(link.paused || awaitingDocument);
  const name = String(message.name || '').trim();
  if (!name || name.length > 150) throw Error('Enter a local skill name.');
  const target = { chat, pageKey: link.pageKey, binding: link.binding };
  await tabMessage(tab.id, { type: 'holdSkill', ...target });
  try {
    const result = await request(link.token, 'skill', { ...address(link), name });
    if (typeof result.content !== 'string' || !result.content) throw Error('The terminal returned an empty skill.');
    await tabMessage(tab.id, { type: 'applySkill', ...target, name, content: result.content });
  } finally {
    await tabMessage(tab.id, { type: 'releaseSkill', ...target }).catch(() => {});
  }
  return { status: 'Clicked Send with ' + name + '. Check the new user message in Arena.' };
}

async function dispatch(message, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('Unknown sender.');
  const link = await getLink();
  if (sender.url?.split(/[?#]/, 1)[0] === chrome.runtime.getURL('popup.html')) return popup(message, link);
  if (!link || sender.frameId !== 0 || sender.documentLifecycle && sender.documentLifecycle !== 'active'
      || sender.tab?.id !== link.tab || message.pageKey !== link.pageKey
      || message.binding !== link.binding) throw Error('Document is not paired.');
  if (message.type === 'depart') {
    if (!link.paused || link.receipt || link.notice)
      await pauseLink(link, 'Bound tab changed conversation. Return to the original chat and reconnect.');
    return {};
  }
  // Chrome can retain the sender URL from before a same-document route change.
  const requireProof = ArenaBridge.conversation(sender.url) !== link.chat;
  if (link.paused || message.chat !== link.chat || requireProof &&
      (!URL.canParse(sender.url) || new URL(sender.url).origin !== new URL(link.chat).origin))
    throw Error('Conversation changed. Reconnect from the original chat.');
  const returning=message.type==='return';
  if (returning && (link.lease || link.receipt || link.notice)) throw Error('Inspect the original active Arena delivery.');
  if (!await verifyTab(link, undefined, requireProof, returning)) throw Error(link.paused || awaitingDocument);
  if (returning) {
    if (link.away) { delete link.away; await save(link); }
    return {};
  }
  if (message.type === 'poll') {
    if (message.recoverTranscript !== undefined) {
      const result = await request(link.token,'poll',{
        ...address(link),ready:false,recoverTranscript:message.recoverTranscript
      });
      return {recoverTranscript:result.recoverTranscript===true};
    }
    const supportsNativeQuestions = message.supportsNativeQuestions === true;
    const nativeQuestionId = supportsNativeQuestions && !link.lease ? message.nativeQuestionId : undefined;
    if (nativeQuestionId!==undefined && (typeof nativeQuestionId!=='string' || !nativeQuestionId || nativeQuestionId.length>256))
      throw Error('Invalid native question identity.');
    const result = await request(link.token, 'poll', {
      ...address(link), ready: message.ready === true && !link.lease,
      recoveredTranscript:message.recoveredTranscript,
      supportsPngBatch: message.supportsPngBatch === true, supportsFiles: message.supportsFiles === true,
      supportsNativeQuestions, nativeQuestionId,
      nativeQuestionClosed:Boolean(nativeQuestionId && message.nativeQuestionClosed===true)
    });
    if (result.job) { link.lease = result.job.id; await save(link); }
    else if (result.lease === null && link.lease) { delete link.lease; delete link.receipt; await save(link); }
    return { job: result.job, queued: result.queued === true, context:result.context,
      supportsNativeQuestions:supportsNativeQuestions && result.supportsNativeQuestions===true,
      supportsImageChoices:supportsNativeQuestions && result.supportsImageChoices===true,
      supportsAudioChoices:supportsNativeQuestions && result.supportsAudioChoices===true,
      supportsAudioQuestions:supportsNativeQuestions && result.supportsAudioQuestions===true,
      nativeQuestionClosed:result.nativeQuestionClosed };
  }
  if (message.type === 'fileChunk') {
    const {job,index,offset}=message;
    if (!job || job !== link.lease || link.receipt || !Number.isSafeInteger(index) || index < 0 ||
        !Number.isSafeInteger(offset) || offset < 0) throw Error('File chunk does not belong to the offered delivery.');
    const result=await request(link.token,'file-chunk',{...address(link),job,index,offset});
    return {data:result.data,nextOffset:result.nextOffset};
  }
  if (message.type !== 'event' || !message.event) throw Error('Invalid content request.');
  const { id, kind, text, job } = message.event;
  const body = { ...address(link), id, kind, text, job };
  if (kind==='busy' && job && job===link.lease && message.event.voicePlaybackRequired===true)
    body.voicePlaybackRequired=true;
  if (kind === 'blocked' && message.event.transcriptChanged === true) body.transcriptChanged = true;
  if (kind === 'user' || kind === 'assistant') body.recoveredTranscript = message.recoveredTranscript;
  const previewCount=[message.event.choicePreviews,message.event.choiceAudio,message.event.questionAudio]
    .filter(preview=>preview!==undefined).length;
  if (previewCount && message.event.nativeQuestion===undefined)
    throw Error('Arena previews require a native question.');
  if (message.event.nativeQuestion!==undefined) {
    const {nativeQuestion,replyTo,choicePreviews,choiceAudio,questionAudio} = message.event;
    if (kind!=='assistant' || message.supportsNativeQuestions!==true || message.event.toolFrame || message.event.images ||
        message.event.audio!==undefined || previewCount>1 ||
        typeof replyTo!=='string' || !replyTo || replyTo.length>256 || !ArenaBridge.validQuestion(nativeQuestion))
      throw Error('Invalid native Arena question.');
    Object.assign(body,{nativeQuestion,replyTo,supportsNativeQuestions:true});
    if (choicePreviews!==undefined) body.choicePreviews=mediaPayload(choicePreviews,'image');
    if (choiceAudio!==undefined) body.choiceAudio=mediaPayload(choiceAudio,'audio');
    if (questionAudio!==undefined) body.questionAudio=mediaPayload(questionAudio,'audio');
  } else if (kind === 'assistant' && message.event.images !== undefined) {
    const replyTo = message.event.replyTo;
    if (typeof replyTo !== 'string' || !replyTo || replyTo.length > 256) throw Error('Missing generated image turn identity.');
    body.replyTo = replyTo;
    body.images = mediaPayload(message.event.images,'image');
  } else if (kind === 'assistant' && typeof message.event.replyTo === 'string' &&
      message.event.replyTo.length > 0 && message.event.replyTo.length <= 256) {
    body.replyTo = message.event.replyTo;
    if (message.event.toolFrame===true && /^[0-9a-f]{32}$/.test(body.replyTo)) body.toolFrame = true;
  }
  if (message.event.audio!==undefined) {
    if (kind!=='assistant' || !body.replyTo || body.toolFrame || body.nativeQuestion)
      throw Error('Invalid generated audio reply.');
    body.audio=mediaPayload(message.event.audio,'audio');
  }
  if (message.event.toolSource !== undefined) {
    if (!body.toolFrame || typeof message.event.toolSource !== 'string' ||
        !message.event.toolSource.length || message.event.toolSource.length > 180000)
      throw Error('Invalid Arena tool source.');
    body.toolSource = message.event.toolSource;
  }
  if (kind === 'user' && typeof message.event.contextId === 'string') body.contextId = message.event.contextId;
  const delivery = job && link.lease === job && ['sent','uncertain','blocked','limited'].includes(kind);
  if (delivery) {
    link.receipt = body;
    await save(link);
  }
  let result;
  try { result=await request(link.token, 'event', body); }
  catch (error) {
    if (!error.audioRejected || !body.audio && !body.choiceAudio && !body.questionAudio) throw error;
    // An explicit rejection precedes acceptance of the event on the companion.
    // Retry the same identity with its text and any images intact.
    const {audio, choiceAudio, questionAudio, nativeQuestion, supportsNativeQuestions: _questions, ...fallback}=body;
    const note=choiceAudio || questionAudio ?
      'Arena is waiting for a choice. The audio files could not be transferred. Use the original Arena tab.' :
      'Arena generated audio, but its files could not be transferred. Open them in the original Arena conversation.';
    fallback.text=[fallback.text,note].filter(Boolean).join('\n\n');
    result=await request(link.token,'event',fallback);
    if (nativeQuestion) result={...result,nativeQuestionHandled:'display-only',
      nativeQuestionId:nativeQuestion.id,replyTo:body.replyTo};
  }
  if (delivery) {
    delete link.receipt;
    delete link.lease;
    await save(link);
  }
  return body.nativeQuestion ? {nativeQuestionHandled:result.nativeQuestionHandled,
    nativeQuestionId:result.nativeQuestionId,replyTo:result.replyTo} : {};
}

let sequence = Promise.resolve();
function serial(work) {
  const next = sequence.then(work);
  sequence = next.catch(() => {});
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial(() => dispatch(message, sender)).then(result => respond({ ...result, ok: true }),
    error => respond({ ok: false, error: error.message }));
  return true;
});

function suspendTab(id, reason) {
  serial(async () => {
    const link = await getLink();
    if (link?.tab === id && !link.paused) await pauseLink(link, reason);
  }).catch(() => {});
}
chrome.tabs.onRemoved.addListener(id => suspendTab(id, 'Bound tab closed.'));
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (!changes.url && changes.status !== 'loading' && changes.status !== 'complete') return;
  serial(async () => {
    const link = await getLink();
    if (link?.tab !== id || link.paused) return;
    if (!link.checkDocument) { link.checkDocument = true; await save(link); }
    await verifyTab(link, changes.status);
  }).catch(() => {});
});
