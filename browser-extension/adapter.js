'use strict';

// Arena role and composer selectors are based on the MIT-licensed arenaai adapter
// in IvanSkainet/arena-agent (chat_extension/adapter_sites.js and adapters.js).
// Restrict those selectors to Agent Mode and positively identified messages.
const ArenaPage = (() => {
  const users = '[data-message-author-role="user"],[data-testid="user-message"],.chat-user,.group.self-end';
  const assistants = '[data-message-author-role="assistant"],[data-testid="assistant-message"],.chat-assistant,#response-content-container';
  const editors = 'textarea:not(.g-recaptcha-response),[contenteditable="true"][role="textbox"],[contenteditable="true"].ProseMirror';
  const sends = 'button[aria-label="Send message" i],button[aria-label="Send" i],button[title="Send message" i],button[data-testid="send-button"]';
  const stops = 'button[aria-label="Stop" i],button[aria-label="Stop generating" i],button[aria-label="Stop generation" i],button[aria-label="Stop response" i],button[data-testid="stop-button"]';
  const pendingUpload = '[role="progressbar"],[aria-busy="true"],[data-upload-status="uploading"],[data-upload-status="error"],[role="alert"]';
  const attachments = 'img[src^="blob:"],img[src^="data:image/"],[data-testid="attachment-preview"],[data-upload-status="complete"]';
  const analysisBody = '.prose.prose-sm.text-text-secondary';
  const analysisPanel = '[data-state="closed"]:has(' + analysisBody + '),[data-state="open"]:has(' + analysisBody + ')';
  const nativeReplyContent = ':scope > .bg-surface-primary.rounded-xl.border.w-full > .px-3.pb-3 > .flex.flex-col.gap-2';
  const nativeFinalBody = nativeReplyContent + ' > .prose.prose-base.body-base';
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el.isConnected && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length;
  const visibleOutput = el => !el.closest('[hidden],[inert],[aria-hidden="true" i]') && visible(el) &&
    Array.from(el.getClientRects()).some(rect => rect.width > 0 && rect.height > 0);
  const active = el => el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const all = (root, selector) => Array.from(root.querySelectorAll(selector));
  const draft = el => el instanceof HTMLTextAreaElement ? el.value : paragraphText(el);
  const transcript = users + ',' + assistants + ',[id^="chat-message-"],.prose,.markdown,pre,code,[contenteditable="true"]';
  const quota = /\b(?:413|429)\b|too many (?:requests|messages|files|attachments|images)|(?:rate|daily|usage|upload|attachment|file|image|message|character|token)[ -]?(?:limit|quota).*(?:exceed|reach|exhaust)|(?:reach|exceed|exhaust).{0,40}(?:limit|quota)|rate[- ]limit|(?:file|image|payload|attachment|request|message) (?:is )?too (?:large|long)|(?:maximum|max).{0,20}(?:files|attachments|images) (?:allowed|reached)|лимит.{0,20}(?:исчерпан|превышен|достигнут)|(?:достиг|превыш|исчерп).{0,35}лимит|слишком (?:много|больш|длин)/iu;
  const quotaWarning = /\b(?:limit|quota)\s+(?:is\s+)?(?:almost|nearly)\s+(?:reached|exhausted)\b|(?:лимит|квота)\s+почти\s+\p{L}+/giu;
  const failed = /(?:upload|attachment|request|send|message|file).{0,25}(?:failed|error|rejected)|(?:failed|unable|could not) to (?:send|upload|attach)|ошибка.{0,20}(?:отправки|загрузки)|не удалось (?:отправить|загрузить)/iu;
  const rejectedFile = /(?:file|format|attachment).{0,35}(?:unsupported|not supported|not allowed|invalid)|(?:unsupported|invalid|disallowed) (?:file|format|attachment)|(?:тип|формат) файла.{0,30}(?:не поддерживается|запрещён)/iu;
  const sanitized = text => String(text || '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, 320);
  const issueError = issue => Object.assign(new Error(issue.text), { kind: issue.kind });
  const limited = text => issueError({ kind:'limited', text });
  const reviewClose = 'button[aria-label="Close review panel" i]';
  const nativeReviewPanel = '.bg-surface-secondary.rounded-md';
  const continueLabel = /^(Продолжить работу|Continue work(?:ing)?)$/i;
  const reviewPrompt = /^(Эта задача была выполнена успешно\?|Was this task completed successfully\?)$/i;
  const verificationPrompt = /^(?:Security Verification\s+)+Please complete this quick security check\b/i;

  function reviewAction(close) {
    const panel = close.closest(nativeReviewPanel);
    if (!panel || panel.querySelector(transcript + ',' + editors)) return null;
    const actions = all(panel, 'button').filter(button => visibleOutput(button) && continueLabel.test(sanitized(button.innerText)));
    const prompt = all(panel, 'p,span,div,h2,h3').some(node =>
      !node.children.length && visibleOutput(node) && reviewPrompt.test(sanitized(node.innerText)));
    return prompt && actions.length === 1 && active(actions[0]) ? actions[0] : null;
  }

  function insertDraft(doc, field, value) {
    if (field instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    } else {
      field.focus();
      doc.getSelection().selectAllChildren(field);
      if (!doc.execCommand(value ? 'insertText' : 'delete', false, value)) throw Error('The editor rejected insertion.');
    }
  }

  function composerScope(field) {
    const form = field?.closest('form,[role="form"],[data-testid="composer"]');
    if (form) return form;
    let withButtons = null;
    for (let node = field?.parentElement; node && !node.matches('body,main,html'); node = node.parentElement) {
      if (!withButtons && node.querySelector(sends + ',' + stops)) withButtons = node;
      if (node.querySelector('input[type="file"]')) return node;
    }
    return withButtons;
  }

  function feedback(doc, scope, button) {
    const blockedCredits = scope ? all(scope, 'button[type="button"][data-severity="blocked"][aria-haspopup="dialog"][aria-controls]')
      .filter(el => visibleOutput(el) && !el.closest(transcript) && quota.test(el.getAttribute('aria-label') || '')) : [];
    const credit = blockedCredits.length === 1 ? blockedCredits[0] : null;
    const label = sanitized(credit?.getAttribute('aria-label'));
    const detail = credit?.getAttribute('aria-expanded') === 'true' ? doc.getElementById(credit.getAttribute('aria-controls')) : null;
    const description = detail?.matches('[role="dialog"][data-state="open"]') && visibleOutput(detail)
      && !detail.closest(transcript) ? sanitized(detail.innerText) : '';
    const ownDetail = !!description && description.startsWith(label);
    const selector = '[role="alert"],[role="alertdialog"],[aria-live="assertive"],[aria-live="polite"]';
    const notices = all(doc, selector);
    if (scope) notices.push(...all(scope, '[role="status"],[data-upload-status="error"],[data-testid*="error" i]'));
    if (button && !active(button)) {
      for (const id of (button.getAttribute('aria-describedby') || '').split(/\s+/)) {
        const related = id && doc.getElementById(id);
        if (related) notices.push(related);
      }
      notices.push(button);
    }
    for (const el of new Set(notices)) {
      if (el === credit || ownDetail && detail.contains(el) || !visible(el) || el.closest(transcript) || el.querySelector(transcript)) continue;
      const message = sanitized([el.innerText,el.title,el.getAttribute('aria-label')].filter(Boolean).join(' '));
      if (quota.test(message.replace(quotaWarning,''))) return { kind:'limited', text:message };
      if (failed.test(message) || rejectedFile.test(message) || el.dataset.uploadStatus === 'error') return { kind:'blocked', text:message || 'Arena reported an upload error.' };
    }
    return credit ? {kind:'limited', text:ownDetail ? description : label, account:true} : null;
  }

  function declaredMax(element, names) {
    const numbers = names.map(name => element.getAttribute(name)).filter(value => value !== null && /^\d+$/.test(value)).map(Number);
    return numbers.length ? Math.min(...numbers) : Infinity;
  }

  function descriptions(field) {
    return (field.getAttribute('aria-describedby') || '').split(/\s+/)
      .map(id => id && field.ownerDocument.getElementById(id))
      .filter(node => node && visible(node) && !node.closest(transcript) && !node.querySelector(transcript));
  }

  function textLimit(field) {
    let cap = declaredMax(field, ['maxlength','data-max-length']);
    for (const counter of descriptions(field)) {
      const count = /^\s*[\d,]+\s*\/\s*([\d,]+)\s*(?:characters?|символ\p{L}*)\s*$/iu.exec(counter.innerText);
      if (count) cap = Math.min(cap, Number(count[1].replaceAll(',','')));
    }
    return cap;
  }

  function fileLimits(input) {
    let bytes = declaredMax(input,['data-max-file-size-bytes','data-max-bytes']);
    let count = declaredMax(input,['data-max-files','data-remaining-files']);
    const scale = {B:1, KB:1000, MB:1000000, GB:1000000000, KIB:1024, MIB:1048576, GIB:1073741824};
    for (const node of descriptions(input)) {
      const size = /(?:max(?:imum)? (?:file|image|attachment|upload) size|максимальный размер файла)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(B|[KMG]i?B)\b/i.exec(node.innerText);
      if (size) bytes = Math.min(bytes,Math.floor(Number(size[1].replace(',','.')) * scale[size[2].toUpperCase()]));
      const slots = /(?:remaining (?:files|attachment slots)|maximum (?:files|attachments))\s*[:=]?\s*(\d+)\b/i.exec(node.innerText);
      if (slots) count = Math.min(count,Number(slots[1]));
    }
    return {bytes,count};
  }

  function previewNodes(scope) {
    const previews = all(scope, attachments).filter(visible);
    return previews.filter(node => !previews.some(other => node !== other && node.contains(other)));
  }

  function previewNames(preview) {
    return [preview.alt, preview.title, preview.getAttribute('aria-label'), preview.textContent].filter(Boolean);
  }

  function removalButtons(scope, includeHidden = false) {
    // A filename stays visible when its removal button is transparent until hover.
    return all(scope,'button[aria-label],button[title]').filter(button =>
      /^(?:Remove|Удалить)\s/i.test(button.getAttribute('aria-label') || button.title) &&
      (includeHidden || !button.closest('[hidden],[inert],[aria-hidden="true" i]') &&
        button.checkVisibility({visibilityProperty:true}) && button.getClientRects().length));
  }

  function originalFileChips(scope, attached, selection) {
    if (all(scope,pendingUpload).some(visible)) return null;
    const current = all(scope,'input[type="file"]').flatMap(input => Array.from(input.files));
    if (current.length && (current.length !== selection.length || current.some((file,i) => file !== selection[i]))) return null;
    const buttons = removalButtons(scope);
    const previews = previewNodes(scope);
    if (!buttons.length) {
      if (previews.length!==attached.length || !previews.every((node,i)=>
        (node.tagName!=='IMG' || node.complete && node.naturalWidth>0) &&
        (previewNames(node).includes(attached[i].name) || node.tagName==='IMG' && current.length && attached.length===1))) return null;
      return previews.map(preview=>({preview,source:previewSource(preview)}));
    }
    if (buttons.length !== attached.length) return null;
    const remaining = new Set(previews);
    const chips = [];
    for (const [index,button] of buttons.entries()) {
      const label = button.getAttribute('aria-label') || button.title;
      const name = attached[index].name;
      let card = button.closest('[data-testid="attachment-preview"],[data-upload-status="complete"]') || button.parentElement;
      if (label !== 'Remove '+name && label !== 'Удалить '+name) {
        if (!/^(?:remove (?:file|image|attachment)|удалить (?:файл|изображение|вложение))$/i.test(label)) return null;
        while (card && card!==scope && !buttons.some(other=>other!==button && card.contains(other))) {
          if (all(card,'[title],[alt],span,p,div').some(el =>
            el.title === name || el.alt === name || !el.children.length && el.textContent === name)) break;
          card=card.parentElement;
        }
        if (!card || card===scope || buttons.some(other=>other!==button && card.contains(other))) return null;
      }
      // A separate preview anywhere else in the composer belongs to another attachment.
      const owned = card && card!==scope ? previews.filter(node=>card.contains(node)) : [];
      if (owned.length>1) return null;
      const preview = owned[0];
      if (preview && !remaining.delete(preview)) return null;
      chips.push({button,preview,source:preview && previewSource(preview)});
    }
    return remaining.size ? null : chips;
  }

  const sameFileChip = (first,next) => first?.button===next?.button && first?.preview===next?.preview &&
    first?.source===next?.source;


  async function originalFile(entry, index, readChunk) {
    if (!entry || typeof entry.name !== 'string' || !entry.name || typeof entry.mediaType !== 'string' ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256))
      throw Error('Invalid Desktop attachment metadata.');
    const chunks = [];
    let offset = 0;
    do {
      const part = await readChunk(index,offset);
      if (typeof part?.data !== 'string' || !Number.isSafeInteger(part.nextOffset) ||
          part.nextOffset < offset || part.nextOffset === offset && offset < entry.size || part.nextOffset > entry.size)
        throw Error('Invalid Desktop file chunk.');
      const raw = atob(part.data);
      if (raw.length !== part.nextOffset-offset) throw Error('Incomplete Desktop file chunk.');
      const bytes=new Uint8Array(raw.length);
      for (let i=0; i<raw.length; i++) bytes[i]=raw.charCodeAt(i);
      chunks.push(bytes);
      offset=part.nextOffset;
    } while (offset<entry.size);
    const file=new File(chunks,entry.name,{type:entry.mediaType});
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()));
    if (Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('') !== entry.sha256)
      throw Error('Desktop file digest mismatch. No attachment was submitted.');
    return file;
  }

  function originalInput(scope) {
    const inputs=all(scope,'input[type="file"]').filter(input=>!input.disabled);
    if (inputs.length===1) return inputs[0];
    const general=inputs.filter(input=>!input.accept.trim() || input.accept.trim()==='*/*');
    if (general.length===1) return general[0];
    throw Error('Cannot identify the file picker in the Arena composer.');
  }

  function pngPayloads(job) {
    if ('pngs' in job) {
      if (job.png != null || !Array.isArray(job.pngs) || job.pngs.length < 2 || job.pngs.length > 20)
        throw limited('A screenshot batch must contain 2 to 20 PNGs in the pngs field.');
      return job.pngs;
    }
    if (job.png == null) return [];
    if (typeof job.png !== 'string') throw limited('A single PNG must use the png field.');
    return [job.png];
  }

  function pngFiles(payloads, input) {
    const limits = fileLimits(input);
    if ((payloads.length > 1 && !input.multiple) || payloads.length > limits.count)
      throw limited('Arena does not have enough attachment slots for all ' + payloads.length + ' PNGs.');
    const maxBytes = Math.min(4 * 1024 ** 2, limits.bytes);
    let total = 0;
    for (const data of payloads) {
      if (typeof data !== 'string' || !data || data.length % 4) throw Error('Invalid base64 PNG.');
      const size = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (size > maxBytes) throw limited('A PNG exceeds the attachment limit of ' + maxBytes + ' bytes.');
      total += size;
      if (total > 32 * 1024 ** 2) throw limited('The screenshot batch exceeds 32 MiB.');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw Error('Invalid base64 PNG.');
    }
    const prefix = 'arena-' + crypto.randomUUID();
    return payloads.map((data, index) => {
      const decoded = atob(data);
      if (!decoded.startsWith('\x89PNG\r\n\x1a\n')) throw Error('Invalid PNG.');
      const bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
      return new File([bytes], prefix + '-' + String(index + 1).padStart(2, '0') + '.png', { type:'image/png' });
    });
  }

  function confirmedPreviews(scope, files) {
    if (all(scope,pendingUpload).some(visible)) return null;
    const previews = previewNodes(scope);
    if (previews.length !== files.length) return null;
    const selected = all(scope,'input[type="file"]').flatMap(input => Array.from(input.files));
    if (selected.length && (selected.length !== files.length || selected.some((file,i) => file !== files[i]))) return null;
    for (const [i, preview] of previews.entries()) {
      const image = preview.tagName === 'IMG';
      if (image && (!preview.complete || !preview.naturalWidth)) return null;
      const named = previewNames(preview).some(value =>
        files.length === 1 ? value.includes(files[i].name) : value.trim() === files[i].name);
      // Older single-file forms retain the actual File but use an unnamed image preview.
      if (!named && !(image && files.length === 1 && selected.length === 1)) return null;
    }
    return previews;
  }

  const previewSource = preview => preview.currentSrc || preview.getAttribute('src');

  async function matchesPngPreview(preview, source, file, base64) {
    if (preview.tagName !== 'IMG' || !source) return false;
    if (source.startsWith('data:')) return source === 'data:image/png;base64,' + base64;
    const url = new URL(source);
    if (url.protocol !== 'blob:' || url.origin !== preview.ownerDocument.location.origin) return false;
    const response = await fetch(url, {credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)});
    if (!response.ok || Number(response.headers.get('content-length')) !== file.size) return false;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const original = new Uint8Array(await file.arrayBuffer());
    return bytes.length === original.length && bytes.every((value,i) => value === original[i]);
  }

  // TipTap renders one paragraph per Enter. Browser innerText inserts an extra
  // newline between paragraphs, while textContent loses the separator entirely.
  function paragraphText(node, markdown = false) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches('button,svg,[aria-hidden="true"],[hidden]')) return '';
    if (node.tagName === 'BR') return node.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
    if (node.tagName === 'PRE') return messageText(node).trim();
    if (node.childNodes.length === 1 && node.firstChild.nodeName === 'BR') return '';
    const lines = [];
    let inline = '';
    for (const child of node.childNodes) {
      const value = paragraphText(child, markdown);
      if (child.nodeType === Node.ELEMENT_NODE && /^(P|DIV|PRE)$/.test(child.tagName)) {
        if (inline) { lines.push(inline); inline = ''; }
        lines.push(value);
      } else inline += value;
    }
    if (inline) lines.push(inline);
    const text = lines.join('\n');
    if (markdown) {
      if (node.matches('strong,b')) return '**' + text + '**';
      if (node.matches('em,i')) return '*' + text + '*';
      if (node.matches('code')) return String.fromCharCode(96) + text + String.fromCharCode(96);
    }
    return text;
  }

  function languageTag(label) {
    const tag = label.trim();
    return /^(json|arenatool|arena-tool)$/i.test(tag) ? tag.toLowerCase() : tag;
  }

  function codeView(pre) {
    const card = pre.querySelector(':scope > div[data-code-block="true"]:only-child');
    const header = card?.firstElementChild;
    const labels = header ? all(header, 'span.text-sm.font-medium') : [];
    const inner = card ? all(card, 'pre.shiki > code.whitespace-pre-wrap') : [];
    if (header?.tagName === 'DIV' && labels.length === 1 && inner.length === 1 && !header.contains(inner[0])) {
      return { code: inner[0], tag: languageTag(labels[0].textContent), header, label: labels[0] };
    }
    const code = pre.querySelector(':scope > code') || pre;
    const label = code.dataset.language || pre.dataset.language || /\blanguage-([\w+-]+)/.exec(code.className)?.[1] || '';
    return { code, tag: languageTag(label) };
  }

  function visibleCodeText(code) {
    return Array.from(code.childNodes, child => messageText(child, true)).join('');
  }

  function messageText(node, visibleOnly=false) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches('button,svg,script,style,[aria-hidden="true"],[hidden],[role="toolbar"],' + analysisPanel)) return '';
    if (visibleOnly && !visibleOutput(node)) return '';
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'PRE') {
      const { code, tag } = codeView(node);
      if (visibleOnly && !visibleOutput(code)) return '';
      const rendered = visibleOnly ? visibleCodeText(code) : code.textContent;
      const content = rendered.replace(/\n$/, '');
      if (visibleOnly && !content.trim()) return '';
      // Longer delimiters keep backticks printed inside code inside their original block.
      const ticks = String.fromCharCode(96);
      const fence = ticks.repeat(Math.max(3, ...(content.match(/\x60+/g) || []).map(run => run.length + 1)));
      return '\n' + fence + tag + '\n' + content + '\n' + fence + '\n';
    }
    const text = Array.from(node.childNodes, child=>messageText(child,visibleOnly)).join('');
    return /^(DIV|P|LI|SECTION|BLOCKQUOTE|H[1-6])$/.test(node.tagName) ? text + '\n' : text;
  }

  const significantChildren = node => Array.from(node.childNodes).filter(child =>
    child.nodeType !== Node.TEXT_NODE || child.textContent.trim());

  function markedPayload(source) {
    let frame;
    try { frame = JSON.parse(source); } catch { return false; }
    if (frame?.$harness !== 'tool_call' || typeof frame.name !== 'string' || !frame.name ||
        !frame.arguments || typeof frame.arguments !== 'object' || Array.isArray(frame.arguments)) return false;
    // These property names are non-integer strings, whose enumeration preserves source order.
    const keys = Object.keys(frame);
    // Send an otherwise valid legacy frame to the server for the missing-ID diagnostic.
    if (keys[0] !== '$harness' || (keys.length !== 3 && (keys.length !== 4 || !Object.hasOwn(frame, 'turn_id')))) return false;

    // JSON.parse collapses repeated keys. Scan the validated source so escaped aliases also count as duplicates.
    const objects = [];
    for (const [token, string, colon] of source.matchAll(/("(?:\\.|[^"\\])*")\s*(:)?|[{}]/g)) {
      if (token === '{') objects.push(new Set());
      else if (token === '}') objects.pop();
      else if (colon) {
        const key = JSON.parse(string), current = objects.at(-1);
        if (current.has(key)) return false;
        current.add(key);
      }
    }
    return true;
  }

  function markedToolFrame(message, bodies, nativeBodies) {
    if (message.dataset.agentTranscriptMessage === 'true' &&
        (!message.dataset.chatMessageId || message.id !== 'chat-message-' + message.dataset.chatMessageId)) return false;
    const blocks = bodies.flatMap(body => all(body, 'pre').filter(el => !el.parentElement.closest('pre')));
    if (blocks.length !== 1) return false;
    const pre = blocks[0];
    const wrapper = pre.parentElement.matches('[data-code-block],[data-rehype-pretty-code-figure],.code-block') ?
      pre.parentElement : pre;
    const body = wrapper.parentElement;
    if (!bodies.includes(body) || !visibleOutput(body)) return false;

    // Establish the code block's source. Separate activity panels and prose never classify its JSON.
    if (body !== message && body.parentElement !== message && !nativeBodies.includes(body) &&
        !(body.parentElement.matches('.bg-surface-primary.rounded-xl.border.w-full') &&
          body.parentElement.parentElement === message)) return false;

    const { code, tag, header, label } = codeView(pre);
    if (tag !== 'json' || code.closest(nonAnswer) || !markedPayload(code.textContent)) return false;
    if (all(code, '*').some(token => !token.matches('span')) || visibleCodeText(code) !== code.textContent) return false;
    if (header && (!visibleOutput(label) || messageText(header).trim() !== label.textContent.trim())) return false;
    const copyButton = 'button[aria-label="Copy code" i],button[aria-label="Copy" i]';
    const controls = 'a,button,input,textarea,select,svg,iframe,object,embed,[role="button"],[contenteditable="true"]';
    if (wrapper.matches(controls) ||
        all(wrapper, controls).some(el => !header?.contains(el) && !el.closest(copyButton))) return false;
    const decoration = copyButton + ',span[aria-label*="Response ended" i],svg';
    for (let child = code; child !== body; child = child.parentElement) {
      if (!visibleOutput(child)) return false;
      const parent = child.parentElement;
      if (parent !== body && Array.from(parent.childNodes).some(sibling =>
        sibling !== child && sibling !== header && !sibling.matches?.(decoration) && messageText(sibling).trim())) return false;
    }
    return true;
  }

  const toolOpening = /^\{\s*"\$harness"\s*:\s*"tool_call"\s*[,}]/;
  const nonAnswer = 'blockquote,q,details,summary,[role="status"],[role="alert"],[role="toolbar"],[role="button"],[contenteditable="true"],'+analysisPanel;

  function hasVisibleToolMarker(body) {
    const tokens = [];
    const walker = body.ownerDocument.createTreeWalker(body,NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (parent && !parent.closest(nonAnswer+',ol,ul,li') && visibleOutput(parent)) tokens.push(text.textContent);
    }
    return /\{\s*"\$harness"\s*:\s*"tool_call"/.test(tokens.join(''));
  }

  function objectEnd(source, start) {
    const expected = [];
    let quoted = false;
    for (let pos = start; pos < source.length; pos++) {
      const char = source[pos];
      if (quoted && char === '\\') { pos++; continue; }
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === '{') expected.push('}');
      else if (!quoted && char === '[') expected.push(']');
      else if (!quoted && (char === '}' || char === ']')) {
        if (expected.pop() !== char) return null;
        if (!expected.length) return pos + 1;
      }
    }
    return null;
  }

  function originalTextArgument(raw, command) {
    let opening = null, block = null;
    const lines = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
    for (const match of raw.matchAll(lines)) {
      if (opening && match.index < command.end && match.index+match[0].length > command.start) return;
      if (match.index >= command.start && match.index < command.end) continue;
      const line = match[0].replace(/(?:\r\n|\r|\n)$/,'');
      const [,indent,fence,label] = /^( {0,3})(\x60{3,}|~{3,})(.*)$/s.exec(line) ?? [];
      if (opening) {
        if (fence?.startsWith(opening.fence) && !/[^ \t]/.test(label)) {
          if (opening.name) {
            if (block) return;
            block = {name:opening.name,start:opening.start,end:match.index+line.length,
              body:raw.slice(opening.body,match.index).replace(/(?:\r\n|\r|\n)$/,'')};
          }
          opening = null;
        }
      } else if (/^ {0,3}<(?:[!?]|\/?[a-z][a-z\d:-]*(?=[\s/>]|$))/i.test(line)) {
        // A raw HTML block can contain fences that Markdown does not render as code.
        return;
      } else if (fence && (fence[0] !== '\x60' || !label.includes('\x60'))) {
        // Indentation can be local to a list. A later dedent is ambiguous here.
        if (indent) return;
        const name = /^harness-text ([A-Za-z][A-Za-z\d_-]{0,31})[ \t]*$/.exec(label)?.[1];
        opening = {fence,name,start:match.index,body:match.index+match[0].length};
      }
    }
    if (!opening?.name) return block;
  }

  function originalToolReply(raw) {
    const candidates = [];
    function addFence(fence, close, end) {
      const source = raw.slice(fence.body,close).trim();
      if (fence.json && toolOpening.test(source))
        candidates.push({start:fence.start,end,source});
    }

    const scopes = [];
    let opening = null, comment = false, consumed = 0;
    const regions = /^(?:(?<fenceIndent> {0,3})(?<delimiter>\x60{3,}|~{3,})(?<label>[^\r\n]*)\r?$|(?<indent>[ \t]*)[\[{])|(?<commentStart><!--)|(?<commentEnd>-->)|<(?<closing>\/)?(?<tag>details|blockquote|pre|code|q|summary|div|span|section|article)\b[^>]*>/gim;
    for (const match of raw.matchAll(regions)) {
      if (match.index < consumed) continue;
      const {delimiter,label,fenceIndent,indent,commentStart,commentEnd,closing,tag} = match.groups;
      const end = match.index + match[0].length;
      if (opening) {
        if (delimiter?.[0] === opening.delimiter[0] && delimiter.length >= opening.delimiter.length && !label.trim()) {
          addFence(opening,match.index,end);
          opening = null;
        }
        continue;
      }
      if (comment || commentStart) { comment = !commentEnd; continue; }
      if (tag) {
        const name = tag.toLowerCase();
        if (!closing && !match[0].endsWith('/>')) scopes.push(name);
        else if (closing && scopes.at(-1) === name) scopes.pop();
        continue;
      }
      if (scopes.length) continue;
      if (delimiter) {
        opening = {delimiter,json:!fenceIndent && label.trim().toLowerCase()==='json',start:match.index,body:end+1};
        continue;
      }
      if (indent === undefined) continue;
      const start = match.index + indent.length;
      const close = objectEnd(raw,start);
      if (close === null) break;
      consumed = close;
      const source = raw.slice(start,close);
      const tail = raw.slice(close);
      if (indent || !toolOpening.test(source) || !/^[ \t]*(?:\r?\n|$)/.test(tail)) continue;
      // A Copy snapshot can glue a fence opener to prose. Strip a paired wrapper
      // only after identifying its contents as a standalone marked object.
      const opener = raw.slice(0,start).match(/(?<![\\\x60~])(\x60{3,}|~{3,})json[ \t]*\r?\n$/i);
      const closer = tail.match(/^[ \t]*\r?\n {0,3}(\x60{3,}|~{3,})[ \t]*(?=\r?\n|$)/);
      const wrapped = opener && closer?.[1].startsWith(opener[1]);
      if (wrapped) consumed += closer[0].length;
      candidates.push({start:wrapped ? opener.index : start,end:consumed,source});
    }
    if (opening) addFence(opening,raw.length,raw.length);
    if (!candidates.length) return {toolFrame:false,responseText:raw};
    const command = candidates[0];
    let block;
    if (candidates.length === 1) {
      try {
        const args = JSON.parse(command.source).arguments;
        if (args && Object.values(args).some(value => value && typeof value === 'object' && Object.hasOwn(value,'$text')))
          block = originalTextArgument(raw,command);
      } catch { /* Strict JSON validation belongs to the companion. */ }
    }
    const spans = block ? [command,block].sort((a,b)=>a.start-b.start) : candidates;
    let plain = [], end = 0;
    for (const candidate of spans) {
      plain.push(raw.slice(end,candidate.start).trim());
      end = candidate.end;
    }
    plain.push(raw.slice(end).trim());
    if (candidates.length !== 1) {
      plain.push('Arena returned more than one marked tool command. No command was run.');
      return {toolFrame:false,responseText:plain.filter(Boolean).join('\n\n')};
    }
    // Copied command candidates start with '{'. Only the extension can add the leading separator.
    const source = block ? `\x1e${command.source}\x1e${block.name}\n${block.body}` : command.source;
    return {toolFrame:true,toolSource:source,responseText:plain.filter(Boolean).join('\n\n')};
  }

  function readReply(node, action = 'arena-harness-read-reply') {
    const nonce = crypto.randomUUID();
    let result;
    let received = false;
    const receive = event => {
      if (event.target !== node || typeof event.detail !== 'string' || event.detail.length > 1080200) return;
      try {
        const reply = JSON.parse(event.detail);
        if (reply.nonce !== nonce) return;
        if (received) { result = {status:'conflict'}; return; }
        received = true;
        if (typeof reply.source === 'string' && reply.source.length <= 180000 &&
            (reply.origin === 'stream' || reply.origin === 'copy')) {
          result = {source:reply.source,origin:reply.origin};
        } else if (reply.status === 'conflict' || reply.status === 'incomplete' || reply.status === 'unobserved') {
          result = {status:reply.status};
        }
      } catch {}
    };
    node.addEventListener('arena-harness-reply-source',receive);
    try { node.dispatchEvent(new CustomEvent(action,{detail:nonce,bubbles:true})); }
    finally { node.removeEventListener('arena-harness-reply-source',receive); }
    return result;
  }

  function emptyNativeReply(node, successor, root) {
    const { agentTranscriptMessage, chatMessageId } = node.dataset;
    if (!successor || agentTranscriptMessage !== 'true' || !chatMessageId || node.id !== 'chat-message-' + chatMessageId ||
        node.matches(users) || node.children.length !== 1 || !node.querySelector(nativeReplyContent + ':empty') ||
        node.textContent.trim()) return false;
    // Keep a trailing placeholder until the site renders a real successor.
    if (successor.dataset.agentTranscriptMessage !== 'true' || !successor.dataset.chatMessageId ||
        successor.id !== 'chat-message-' + successor.dataset.chatMessageId || successor.matches(users) ||
        !successor.querySelector(nativeFinalBody)) return false;
    const allowed = ['id','class','tabindex','data-agent-transcript-message','data-chat-message-id'];
    if (node.getAttributeNames().some(attr => !allowed.includes(attr))) return false;
    if (all(node, '*').some(child => child.tagName !== 'DIV' || child.attributes.length !== 1 ||
        !child.hasAttribute('class'))) return false;
    // An empty native scaffold is safe to omit only while its identity is unambiguous.
    const id = CSS.escape(node.id);
    const nativeId = CSS.escape(chatMessageId);
    return all(root, `#${id},[data-message-id="${id}"],[data-message-id="${nativeId}"],[data-chat-message-id="${nativeId}"]`).length === 1;
  }

  class Page {
    constructor(doc) {
      this.doc = doc;
      this.nodeIds = new WeakMap();
      this.replyNodes = new WeakMap();
      this.submittedNodes = new WeakMap();
      this.originalReplies = new WeakMap();
      this.nextNodeId = 1;
    }

    recoverToolReply(row, delivery) {
      const node = this.replyNodes.get(row);
      if (!row.complete) return;
      const previous = this.originalReplies.get(node);
      const canReadTool = (row.visibleToolMarker || row.toolFrame) && /^[a-f\d]{32}$/.test(delivery || '');
      // Keep the same proof on the unchanged row. Publication independently
      // rechecks every possible command before sending it to Harness.
      if (previous && previous.siteId === row.siteId && previous.text === row.text && previous.delivery === delivery) return;
      const evidence = node && readReply(node);
      const raw = evidence?.source;
      let reply;
      if (evidence?.status === 'conflict' && canReadTool) {
        reply = {toolFrame:false,toolSource:undefined,nativeSourceRejected:true,
          responseText:'Arena reported conflicting versions of the streamed reply. No command was run.'};
      } else if (raw === undefined && canReadTool) {
        const reason = evidence?.status === 'incomplete' ? 'Arena’s response stream was incomplete.'
          : 'Arena’s original tool reply is unavailable.';
        reply = {toolFrame:false,toolSource:undefined,nativeSourceRejected:true,sourceIncomplete:evidence?.status === 'incomplete',responseText:reason+' No command was run.'};
      } else if (raw !== undefined) {
        reply = canReadTool ? originalToolReply(raw) : {toolFrame:false,responseText:raw};
      } else return;
      row.copiedMarkdown = raw;
      row.sourceOrigin = evidence?.origin;
      if (node && !reply.sourceIncomplete) this.originalReplies.set(node,{siteId:row.siteId,text:row.text,raw,reply,delivery,origin:evidence?.origin});
      Object.assign(row,reply);
    }

    confirmToolReply(row, receipt) {
      const node = this.replyNodes.get(row);
      const original = this.originalReplies.get(node);
      const origin = receipt?.origin ?? original?.origin;
      const source = receipt?.source ?? original?.raw;
      const siteId = receipt?.siteId ?? original?.siteId;
      if (!origin || !node || !row.complete || !row.visibleToolMarker || row.siteId !== siteId) return false;
      if (!receipt && (!original?.reply.toolSource || original.reply.toolSource !== row.toolSource)) return false;
      const latest = readReply(node,'arena-harness-confirm-'+origin);
      return latest?.origin === origin && latest.source === source ||
        origin === 'stream' && latest?.status === 'unobserved';
    }

    captureReplySource(row) {
      const node = this.replyNodes.get(row);
      if (!node || !row.complete || !row.text) return;
      if (row.copiedMarkdown !== undefined) return row.copiedMarkdown;
      const original = this.originalReplies.get(node);
      if (original && original.siteId === row.siteId && original.text === row.text &&
          original.raw !== undefined && (!original.reply.toolFrame || row.toolFrame && row.toolSource === original.reply.toolSource)) {
        row.sourceOrigin = original.origin;
        return original.raw;
      }
      const evidence = readReply(node);
      row.sourceOrigin = evidence?.origin;
      return evidence?.source;
    }

    historyReplySource(row, origin) {
      const submitted = this.submittedNodes.get(row);
      if (submitted) return readReply(submitted,'arena-harness-check-submitted')?.source;
      const node = this.replyNodes.get(row);
      if (!node || !row.complete || !row.text) return;
      if (origin === 'stream') {
        const evidence = readReply(node,'arena-harness-check-stream');
        return evidence?.source ?? evidence;
      }
      return readReply(node,'arena-harness-check-history')?.source;
    }

    rows() {
      const root = this.doc.querySelector('main') || this.doc.body;
      const selector = users + ',' + assistants + ',[id^="chat-message-"]';
      const priorImages = new Set();
      const nodes = all(root, selector)
        .filter(node => visible(node) && !node.parentElement.closest(selector + ',form,pre,code,[contenteditable="true"]'));
      return nodes
        .filter((node, index) => !emptyNativeReply(node, nodes[index + 1], root))
        .map(node => {
          const isUser = node.matches(users) || node.querySelector('.group.items-end .bg-surface-raised .prose')
            || node.matches('.group.items-end') && node.querySelector('.bg-surface-raised .prose');
          const ended = all(node,'span[aria-label*="Response ended" i]').some(marker =>
            !marker.closest('.prose,.markdown,pre,code,[hidden],[inert],[aria-hidden="true"],'+analysisPanel) &&
            visible(marker) && (!node.id.startsWith('chat-message-') || marker.closest('[id^="chat-message-"]')===node));
          const artifact = !isUser ? ArenaGeneratedImages.find(node,priorImages) : null;
          const nativeQuestion = !isUser ? ArenaNativeQuestions.find(node,ended) : null;
          const imageChoices = !isUser ? ArenaNativeQuestions.findImageChoices(node) : [];
          const isAssistant = artifact || nativeQuestion || imageChoices.length || node.matches(assistants) || node.querySelector('.bg-surface-primary.rounded-xl.border.w-full .prose')
            || node.matches('.bg-surface-primary.rounded-xl.border.w-full') && node.querySelector('.prose');
          const nativeBodies = !isUser && isAssistant ? all(node, nativeFinalBody) : [];
          const directBodies = node.id.startsWith('chat-message-') ? nativeBodies : [];
          const bodies = all(node, '[data-testid="message-content"],[data-message-content],.markdown,.prose')
            .filter(el => !el.closest(analysisBody + ',[data-state="closed"]')
              && !el.parentElement.closest('.prose,.markdown,[data-message-content],[data-testid="message-content"]'));
          const hasAnalysis = !!node.querySelector(analysisBody);
          // Native file previews also contain .prose, outside the assistant's message body.
          const finalBodies = directBodies.length ? directBodies :
            hasAnalysis ? bodies.filter(el => el.matches('.prose.prose-base.body-base')) : bodies;
          const body = finalBodies.length === 1 ? finalBodies[0] : finalBodies.length || hasAnalysis || artifact || nativeQuestion || imageChoices.length ? null : node;
          const multipleFinalBodies = directBodies.length>1 &&
            directBodies.every(el => el.parentElement === directBodies[0].parentElement);
          const wrapperId = node.closest('[id^="chat-message-"]')?.id;
          const explicitId = node.getAttribute('data-message-id');
          const siteId = explicitId && wrapperId !== 'chat-message-' + explicitId ? explicitId : wrapperId || null;
          if (!this.nodeIds.has(node)) this.nodeIds.set(node,this.nextNodeId++);
          for (const img of node.querySelectorAll('img')) {
            const url=ArenaGeneratedImages.source(img);
            if (url) priorImages.add(url);
          }
          const commandBodies = body ? [body] : multipleFinalBodies && ended ? directBodies : [];
          const command = !nativeQuestion && !imageChoices.length && !artifact && isAssistant && !isUser && commandBodies.length ?
            markedToolFrame(node, commandBodies, nativeBodies) : false;
          let prose = body ? (isUser && !isAssistant ? paragraphText(body) : messageText(body, command)).trim() :
            multipleFinalBodies && ended ? directBodies.map(el=>messageText(el,true).trim()).filter(Boolean).join('\n\n') : '';
          let postImageProse = '';
          if (artifact && commandBodies.length) {
            if (commandBodies.every(el=>nativeBodies.includes(el)))
              prose=commandBodies.flatMap(significantChildren).map(child=>messageText(child,true).trim()).filter(Boolean).join('\n\n');
            const lastImage=artifact.images?.at(-1);
            if (lastImage)
              postImageProse=nativeBodies.filter(el=>commandBodies.includes(el) && visibleOutput(el) &&
                (lastImage.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
                .flatMap(significantChildren).map(el=>messageText(el,true).trim()).filter(Boolean).join('\n\n');
          }
          const row = {
            role: isUser && !isAssistant ? 'user' : isAssistant && !isUser ? 'assistant' : 'unknown',
            text: nativeQuestion ? [prose,ArenaNativeQuestions.describe(nativeQuestion)].filter(Boolean).join('\n\n') : prose,
            nativeQuestion, imageChoices, prose, multipleFinalBodies, postImageProse,
            echoMarkdown: body && isUser && !isAssistant ? paragraphText(body, true).trim() : undefined,
            lastLine: body && isUser && !isAssistant ? body.innerText.replace(/[\r\n]+$/, '').split(/\r?\n/).at(-1) : undefined,
            domKey: this.nodeIds.get(node),
            nativeMessage: node.id.startsWith('chat-message-'),
            artifact, artifactsPending:!!artifact,
            toolFrame: !!command,
            siteId,
            complete: !!(body || artifact || nativeQuestion || imageChoices.length || multipleFinalBodies && prose) && (ended ||
              node.matches('[data-message-status="complete"],[data-message-status="completed"],[data-streaming="false"],[data-status="complete"]'))
          };
          if (row.role === 'user' && row.nativeMessage && row.siteId === node.id && row.lastLine &&
              node.dataset.agentTranscriptMessage === 'true' && node.id === 'chat-message-' + node.dataset.chatMessageId)
            this.submittedNodes.set(row,node);
          if ((row.toolFrame || nativeBodies.length && commandBodies.every(el=>nativeBodies.includes(el))) &&
              row.role === 'assistant' &&
              node.dataset.agentTranscriptMessage === 'true' && node.id === 'chat-message-' + node.dataset.chatMessageId &&
              !nativeQuestion && !imageChoices.length && !artifact) {
            this.replyNodes.set(row,node);
            row.visibleToolMarker = !!command || row.text.includes('"$harness"') && commandBodies.some(hasVisibleToolMarker);
          }
          const original = this.originalReplies.get(node);
          if (original && original.siteId === row.siteId && original.text === row.text &&
              (!original.reply.toolFrame || row.visibleToolMarker)) Object.assign(row,original.reply,{sourceOrigin:original.origin});
          return row;
        });
    }

    selectNativeAnswer(request) {
      const rows=this.rows(), current=rows.at(-1)?.nativeQuestion;
      if (current?.status!=='active' || current.draft || !ArenaBridge.sameQuestion(current,request) ||
          rows.filter(row=>row.nativeQuestion?.id===request.id).length!==1 ||
          !current.options.includes(request.answer)) throw Error('The original Arena question or available choices changed.');
      current.buttons[current.options.indexOf(request.answer)].click();
    }

    selectImageChoice(request, sources) {
      const matches=this.rows().flatMap(row=>row.imageChoices).filter(card=>card.id===request.id);
      const current=matches[0];
      if (matches.length!==1 || current.status!=='active' || !ArenaBridge.sameQuestion(current,request) ||
          sources.length!==current.sources.length || !sources.every((source,index)=>source===current.sources[index]) ||
          !current.options.includes(request.answer)) throw Error('The original Arena image choices or previews changed.');
      current.buttons[current.options.indexOf(request.answer)].click();
    }

    state() {
      const editorsOutsideChat = all(this.doc, editors).filter(el => !el.closest(users + ',' + assistants + ',pre,code'));
      const fields = editorsOutsideChat.filter(visible);
      const field = fields.length === 1 ? fields[0] : null;
      const scope = composerScope(field);
      const buttons = scope ? all(scope, sends).filter(visible) : [];
      const button = buttons.length === 1 ? buttons[0] : null;
      const generating = all(this.doc, stops).some(visible) || !!this.doc.querySelector('[data-streaming="true"],[data-message-status="streaming"]');
      const reviewers = all(this.doc, reviewClose).filter(el => visibleOutput(el) && !el.closest(transcript));
      const review = reviewers.length > 0;
      if (!review) this.continuedReview = false;
      const issue = feedback(this.doc, scope, button);
      const verification = all(this.doc, '[role="dialog"]').some(dialog =>
        !dialog.closest(transcript) && visibleOutput(dialog) && verificationPrompt.test(sanitized(dialog.innerText)));
      const value = field ? draft(field) : null;
      const emptyTipTap = scope && field?.matches('.tiptap.ProseMirror') && value === '' && buttons.length === 0;
      const idle = !!(active(field) && !field.readOnly && (button || emptyTipTap) && !generating && !review && !issue && !verification);
      const upload = scope && (all(scope, attachments + ',' + pendingUpload).some(visible) || removalButtons(scope).length>0 ||
        all(scope, 'input[type="file"]').some(el => el.files.length));
      const hiddenEditors = review ? editorsOutsideChat.filter(el => !visible(el)) : [];
      return { field, scope, button, ambiguous: fields.length > 1, generating, idle, value, upload, review, hiddenEditors, verification,
        reviewAction: reviewers.length === 1 ? reviewAction(reviewers[0]) : null,
        issue, ready: idle && !value && !upload };
    }

    continueWork({value = '', attachmentScope = null, ownedField = null, ownedText = value} = {}) {
      const state = this.state();
      const last = this.rows().at(-1);
      if (this.continuedReview || !state.reviewAction || state.ambiguous || state.generating || state.issue || state.verification ||
          state.field && state.value !== value || state.upload && state.scope !== attachmentScope ||
          last?.role !== 'assistant' || !last.complete) return false;
      for (const field of state.hiddenEditors) {
        const contents = draft(field);
        if (contents && (field !== ownedField || contents !== ownedText)) return false;
        const scope = composerScope(field);
        if (scope && scope !== attachmentScope && (scope.querySelector(attachments + ',' + pendingUpload) || removalButtons(scope,true).length ||
            all(scope,'input[type="file"]').some(el => el.files.length))) return false;
      }
      this.continuedReview = true;
      state.reviewAction.click();
      return true;
    }

    browserAttachment({scope,upload}) {
      if (!upload) return null;
      const files = () => all(scope,'input[type="file"]').flatMap(input => Array.from(input.files));
      const selected = files();
      const previews = previewNodes(scope);
      if (selected.length > 1 || previews.length > 1) throw limited('The bridge accepts one PNG per turn.');
      const preview = previews[0], original = selected[0];
      const name = original?.name || (preview && previewNames(preview).find(value => /\.png$/i.test(value)));
      if (!name || !/\.png$/i.test(name) || !preview) throw Error('Inspect the PNG attachment and its preview before sending.');
      const src = preview.getAttribute('src');
      return () => {
        const current = files(), now = previewNodes(scope);
        return now.length === 1 && now[0] === preview && preview.getAttribute('src') === src
          && !all(scope,pendingUpload).some(visible) && (preview.tagName !== 'IMG' || preview.complete && preview.naturalWidth > 0)
          && (current.length ? current.length === 1 && current[0] === original : previewNames(preview).some(label => label.includes(name)));
      };
    }

    async submit(job, expectedDraft, sameContext, beforeClick, retained = null, recover = false, discardStagedText = null, readChunk = null) {
      const suffix = typeof job.receipt==='string' && /^Bridge delivery [a-f\d]{32}$/.test(job.receipt) ?
        '\n\n'+job.receipt : '';
      const payloadText = suffix && job.text.endsWith(suffix) ? job.text.slice(0,-suffix.length) : job.text;
      if (payloadText.length > 180000 && Array.from(payloadText).length > 180000) throw limited('The bridge allows 180000 Unicode characters per turn.');
      const payloads = pngPayloads(job);
      if ('files' in job && (!Array.isArray(job.files) || !job.files.length || payloads.length || retained || !readChunk))
        throw Error('Invalid Desktop file delivery.');
      const checkLimit = field => {
        const siteMax = textLimit(field);
        if (job.text.length > siteMax) throw limited('Arena composer allows ' + siteMax + ' UTF-16 units. Draft requires ' + job.text.length + '.');
      };
      let field, scope, attaching = false, staged = false, restored = false;
      const checkContext = (verifySource = false) => {
        if (sameContext(verifySource)) return;
        if (staged && !expectedDraft && !attaching && !retained && discardStagedText?.()) {
          const state = this.state();
          if (state.idle && state.field === field && state.scope === scope && state.value === job.text && !state.upload)
            insertDraft(this.doc, field, '');
        }
        throw Error('The Arena conversation changed before Send.');
      };
      const check = () => {
        checkContext();
        const state = this.state();
        if (state.issue) throw issueError(state.issue);
        if (state.generating) throw Error('Arena started another response before Send.');
        if (state.ambiguous) throw Error('Multiple Arena editors appeared before Send.');
        const expected = staged ? job.text : expectedDraft;
        const changedEditor = field && (state.field !== field || state.scope !== scope);
        if (changedEditor && (!recover || attaching || retained) && (state.field || !recover))
          throw Error(attaching || retained ? 'The Arena editor changed while preparing attachments. Inspect the draft.' : 'The Arena editor changed before Send.');
        if (retained ? !retained() : state.upload && !attaching)
          throw Error('Attachments changed before Send. Inspect the Arena draft.');
        // Only an empty replacement can receive a confirmed bridge draft again.
        const canRestore = recover && staged && changedEditor && state.value === '' && !restored && draft(field) === expected;
        if (state.field && state.value !== expected && !canRestore)
          throw Error('The Arena draft changed before Send. Your draft was kept.');
        if (staged && !state.field && draft(field) !== expected)
          throw Error('The Arena draft changed before Send. Your draft was kept.');
        if (state.review && recover) {
          this.continueWork({value: canRestore ? '' : expected, attachmentScope: attaching ? scope : null,
            ownedField: staged ? field : null, ownedText: expected});
          return null;
        }
        if (!state.idle) {
          if (!recover && !field) throw Error('Arena has no idle composer for this draft.');
          return null;
        }
        if (canRestore) {
          checkLimit(state.field);
          field = state.field;
          scope = state.scope;
          restored = true;
          insertDraft(this.doc, field, job.text);
          return null;
        }
        if (changedEditor) {
          checkLimit(state.field);
          field = state.field;
          scope = state.scope;
        }
        return state;
      };
      const wait = async (select, ms, error) => {
        const end = Date.now() + ms;
        do {
          const state = check();
          const result = state && select(state);
          if (result) return result;
          if (Date.now() >= end) {
            if (this.state().review) throw Error('The Arena review panel is still blocking the composer. Inspect the browser draft.');
            throw Error(error);
          }
          await pause(80);
        } while (true);
      };
      ({field, scope} = await wait(state => state, 7000, 'Arena did not restore an idle composer before Send.'));
      checkLimit(field);
      let accepted = retained || (() => true);
      if (job.files) {
        const input=originalInput(scope), limits=fileLimits(input);
        if (job.files.length>limits.count || job.files.some(file=>file.size>limits.bytes))
          throw limited('The selected files exceed the limits shown by the Arena file picker.');
        const files=[];
        for (const [index,entry] of job.files.entries()) files.push(await originalFile(entry,index,readChunk));
        // Some forms clear their FileList. Add repeated names one at a time so
        // each removal control can be tied to the specific original we appended.
        const separate=!input.multiple || new Set(files.map(file=>file.name)).size!==files.length;
        const batches=separate ? files.map(file=>[file]) : [files];
        const attached=[];
        let confirmed=[];
        for (const selection of batches) {
          if (!check() || !accepted()) throw Error('The Arena draft changed during file preparation.');
          const picker=originalInput(scope), transfer=new DataTransfer();
          for (const file of selection) transfer.items.add(file);
          attaching=true;
          picker.files=transfer.files;
          picker.dispatchEvent(new Event('change',{bubbles:true}));
          attached.push(...selection);
          const previous=confirmed;
          confirmed=await wait(()=>originalFileChips(scope,attached,selection),120000,
            'Arena did not confirm all selected files in order. Inspect its attachment list.');
          if (!previous.every((chip,i)=>sameFileChip(chip,confirmed[i]))) throw Error('Attached files changed while adding the next original.');
          accepted=()=>originalFileChips(scope,attached,selection)?.every((chip,i)=>
            sameFileChip(chip,confirmed[i]));
        }
      } else if (payloads.length) {
        const inputs = all(scope, 'input[type="file"]').filter(el => !el.disabled && (!el.accept || /image\/(?:\*|png)|\.png\b/i.test(el.accept)));
        if (inputs.length !== 1) throw Error('Cannot identify one PNG attachment input.');
        const files = pngFiles(payloads, inputs[0]);
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        attaching = true;
        inputs[0].files = transfer.files;
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        const confirmed = await wait(() => confirmedPreviews(scope, files), 8000,
          'Arena did not confirm all ' + files.length + ' PNG previews in order. Inspect the draft.');
        const sources = confirmed.map(previewSource);
        accepted = () => confirmedPreviews(scope, files)?.every((preview, i) =>
          preview === confirmed[i] && previewSource(preview) === sources[i]);
        if (files.length > 1) {
          for (const [i,file] of files.entries()) {
            if (!await matchesPngPreview(confirmed[i], sources[i], file, payloads[i]))
              throw Error('Arena preview ' + (i+1) + ' does not match its PNG. Inspect the draft.');
          }
          if (!accepted()) throw Error('The screenshot previews changed during verification. Inspect the draft.');
        }
      }
      await wait(state => {
        if (!accepted()) throw Error('Attachments changed before Send. Inspect the Arena draft.');
        checkLimit(field);
        staged = true;
        insertDraft(this.doc, field, job.text);
        return state;
      }, 7000, 'Arena did not restore the composer before draft preparation.');
      await pause(80);
      await wait(state => {
        if (!accepted()) throw Error('Attachments changed before Send. Inspect the Arena draft.');
        if (!active(state.button)) return false;
        // The native Copy action can synchronously redraw the form during source verification.
        checkContext(true);
        const final = check();
        if (!final || final.field !== state.field || final.scope !== state.scope ||
            final.button !== state.button || !active(final.button))
          throw Error('The Arena Send control changed during verification. Inspect the draft.');
        if (!accepted()) throw Error('Attachments changed before Send. Inspect the Arena draft.');
        checkLimit(final.field);
        beforeClick();
        final.button.click();
        return true;
      }, recover ? 7000 : 2500, 'Arena did not enable Send for the preserved draft. Inspect the composer.');
    }
  }
  return Page;
})();
