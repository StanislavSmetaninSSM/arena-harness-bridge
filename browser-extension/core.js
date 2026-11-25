'use strict';

const ArenaBridge = (() => {
  const maxGeneratedImages = 20;
  function conversation(address) {
    try {
      const url = new URL(address);
      if (!['https://arena.ai', 'https://www.arena.ai'].includes(url.origin)
          || url.username || url.password || url.search || url.hash) return null;
      const match = /^\/agent\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
      if (!match || ['chat', 'new', 'settings', 'history'].includes(match[1].toLowerCase())) return null;
      return url.origin + '/agent/' + match[1];
    } catch { return null; }
  }

  function event(kind, fields = {}) {
    return { id: crypto.randomUUID(), kind, ...fields };
  }

  function awayAgentRoute(original, address) {
    try {
      const url = new URL(address);
      if (url.origin !== new URL(original).origin || url.username || url.password || url.search || url.hash) return false;
      return /^\/agent\/?$/.test(url.pathname) || Boolean(conversation(address) && conversation(address) !== original);
    } catch { return false; }
  }

  function validQuestion(value) {
    const label = (s,max) => typeof s === 'string' && s.length <= max && !!s.trim();
    return value && Object.keys(value).length === 3 && label(value.id,256) && label(value.question,16000)
      && Array.isArray(value.options) && value.options.length >= 1 && value.options.length <= 64
      && value.options.every(option=>label(option,2000)) && new Set(value.options).size===value.options.length;
  }

  function sameQuestion(a,b) {
    return a && b && a.id===b.id && a.question===b.question && Array.isArray(b.options) &&
      a.options.length===b.options.length && a.options.every((value,i)=>value===b.options[i]);
  }

  function confirmedQuestion(wire,card,answer) {
    return card?.status==='answered' && card.selected===answer && wire.options.includes(answer) &&
      (sameQuestion(wire,card) || card.summary===true && card.id===wire.id && card.question===wire.question);
  }

  function delivery(original, job) {
    const id = /^[a-f\d]{32}$/.test(job || '') ? job : crypto.randomUUID().replaceAll('-','');
    const receipt = 'Bridge delivery ' + id;
    return { text:original + '\n\n' + receipt, receipt };
  }

  function userPrompt(original) {
    let prompt = original.trim();
    if (prompt.startsWith('DeepSeek Harness tool result:')) return '';
    // Desktop appends the current mode after the user's prompt. During planning
    // an image request describes work to plan, so we must let its review arrive.
    if (/\n\nDeepSeek Harness plan mode: ACTIVE\. [^\n]+$/u.test(prompt)) return '';
    if (/^(DeepSeek Harness Desktop is connected|Local project context from DeepSeek Harness\.)/.test(prompt)) {
      const boundary = prompt.indexOf('\n\n');
      if (boundary < 0) return '';
      prompt = prompt.slice(boundary+2).trimStart();
    }
    return prompt.split('\n\nLocal skill (',1)[0];
  }

  function requestsImage(prompt) {
    if (/^!image\s+\S/u.test(prompt)) return 'explicit';
    if (/\b(?:docker|oci|container|disk|boot|iso|system|virtual machine) images?\b|\bdraw (?:up |from |(?:an? |the )?(?:conclusion|comparison|parallel|inference)\b)/iu.test(prompt)) return false;
    if (/\b(?:ascii art|mermaid diagram)\b|(?:do not|don't|не нужно|не надо)\s+(?:generate|draw|render|генерировать|рисовать)/iu.test(prompt)) return false;
    // An explanation governs its coordinated verbs. A separate imperative can still request an image.
    return prompt.split(/[.!?;\n]+|,\s*(?:and|then|и|затем)\s+|\s+(?:(?:and|и|а)\s+)?(?:then|затем)\s+/iu).some(part => {
      const sentence = part.trim().replace(/^(?:(?:can|could|would|will) you|можешь(?: ли ты)?|можете(?: ли вы)?)\s+/iu,'')
        .replace(/^(?:please|пожалуйста)[,\s]+/iu,'');
      for (const clause of sentence.split(/\s+(?:and|и)\s+/iu)) {
        if (/^(?:explain|describe|read|inspect|analy[sz]e|identify|summarize|review|how|what|объясни|расскажи|опиши|прочитай|проанализируй|как)(?:[\s,]|$)/iu.test(clause)) return false;
        // The action after "how to" describes the example, including any coordinated verbs.
        const instruction = /\bhow to\b|(?:^|[\s,])как\s/iu.exec(clause);
        if (instruction) return imageInstruction(clause.slice(0,instruction.index));
        if (imageInstruction(clause)) return true;
      }
      return false;
    });
  }

  function requestedImageCount(prompt) {
    const count = /(?:^|\s)(\d{1,2}|ten|десять)\s+(?:(?:separate|distinct|individual|different|отдельных|разных)\s+)?(?:images?|pictures?|иллюстраци\p{L}*|изображени\p{L}*|картин\p{L}*)(?=\s|[,.!?;:]|$)/iu.exec(prompt);
    const size = /^(?:ten|десять)$/iu.test(count?.[1] ?? '') ? 10 : Number(count?.[1]);
    return Number.isInteger(size) && size >= 2 && size <= maxGeneratedImages ? size : null;
  }

  function imageInstruction(prompt) {
    // A sample image is a visual deliverable. A sample request or an example of a call is documentation.
    const data = /\b(?:json|schema|(?:example|sample)(?=\s+(?:of|for|to|request|response|code|call|command|prompt|usage)\b|$))\b|пример|образец|схем/iu.exec(prompt);
    if (data) {
      const lead = prompt.slice(0,data.index).trim();
      if (/^(?:please\s+)?(?:show|give|provide|write|return|print|output|покажи(?:те)?|дай(?:те)?|приведи(?:те)?|напиши(?:те)?|выведи(?:те)?|верни(?:те)?)(?:\s|$)/iu.test(lead) ||
          /^(?:please\s+)?(?:generate|create|produce|make|сгенерируй(?:те)?|создай(?:те)?|сделай(?:те)?)(?:\s+(?:me|an?|the|some|valid|sample|мне))*$/iu.test(lead)) return false;
    }
    return /(?:^|\bplease\s+|\byou\s+|\bthen\s+)(?:draw|paint|illustrate)\b/iu.test(prompt)
      || /\b(?:use|invoke|call|using)\b[^.!?\n]{0,64}\b(?:image[- ]generat(?:ion|or)|image tool|text[- ]to[- ]image)\b/iu.test(prompt)
      || /\b(?:generate|create|make|render|produce)\b[^.!?\n]{0,100}\b(?:image|picture|photo(?:graph)?|portrait|illustration|painting|artwork|poster|wallpaper|watercolou?r|sketch|drawing|collage|cartoon|landscape)s?\b/iu.test(prompt)
      || /(?:используй(?:те)?|вызови(?:те)?)[^.!?\n]{0,64}(?:генератор изображений|генераци[ию] изображений)/iu.test(prompt)
      || /(?:нарисуй(?:те)?|изобрази(?:те)?)\s/iu.test(prompt)
      || /(?:сгенерируй(?:те)?|создай(?:те)?|сделай(?:те)?|создать|сгенерировать)[^.!?\n]{0,90}(?:изображени|картинк|рисунок|портрет|иллюстраци|фотограф|постер)/iu.test(prompt);
  }

  function imageUnavailable(text) {
    return /^(?:(?:sorry|unfortunately)[,.!]?\s+)?(?:image generation (?:failed|is unavailable)|no image (?:was|could be) generated|(?:I (?:am |was )?)?(?:could not|couldn['’]t|cannot|can['’]t|unable to|failed to) (?:generate|create|render|attach) (?:an? |the |this )?(?:image|picture|photo))\b/iu.test(text)
      || /^(?:(?:к сожалению|извините)[,.!]?\s+)?(?:(?:я )?(?:не удалось|не могу|не смог\p{L}*)\s+(?:создать|сгенерировать|нарисовать|прикрепить)\s+(?:изображени|картинк|иллюстраци)|генерация (?:изображения|картинки) (?:не удалась|недоступна))/iu.test(text);
  }

  function uniqueRow(rows,row,history=[]) {
    const key = row.siteId ? 'siteId' : 'domKey';
    return !!row[key] && !history.some(old => old[key] === row[key]) &&
      rows.filter(other => other[key] === row[key]).length === 1;
  }

  function pairingSettlement(rows) {
    const reply=rows.at(-1);
    if (reply?.role!=='assistant' || !reply.complete || reply.nativeQuestion ||
        reply.artifact?.pending || reply.artifact?.error || (!reply.text && !reply.artifact && !reply.audioArtifact)) return;
    let index=rows.length-2;
    if (reply.audioArtifact) {
      while (index>=0 && rows[index].role==='assistant') {
        const earlier=rows[index--];
        if (!earlier.complete || earlier.toolFrame || earlier.nativeQuestion || !earlier.audioChoices?.length ||
            earlier.audioChoices.some(card=>!['selected','skipped'].includes(card.status)) ||
            !earlier.nativeMessage || !earlier.siteId?.startsWith('chat-message-') || !uniqueRow(rows,earlier)) return;
      }
    }
    const echo=rows[index];
    if (echo?.role!=='user' ||
        ![echo,reply].every(row=>row.nativeMessage && row.siteId?.startsWith('chat-message-') && uniqueRow(rows,row))) return;
    const delivery=/^Bridge delivery ([a-f\d]{32})$/.exec(echo.lastLine ?? '')?.[1];
    if (delivery && rows.filter(row=>row.role==='user' && row.lastLine===echo.lastLine).length===1) return delivery;
  }

  function mediaResource(source) {
    try {
      const url = new URL(source);
      if (!['https:','blob:'].includes(url.protocol) || url.username || url.password) return null;
      // Only a named signing scheme on an explicitly identified object is renewable.
      // Proxy selectors, version IDs and unfamiliar query parameters remain part of its identity.
      if (url.protocol==='https:' && /(?:^|\/)[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}(?:[./]|$)/i.test(url.pathname)) {
        for (const [prefix,algorithm] of [['X-Amz-','AWS4-HMAC-SHA256'],['X-Goog-','GOOG4-RSA-SHA256']]) {
          if (url.searchParams.get(prefix+'Algorithm')===algorithm && url.searchParams.has(prefix+'Signature')) {
            for (const key of ['Algorithm','Signature','Credential','Date','Expires','SignedHeaders','Security-Token'])
              url.searchParams.delete(prefix+key);
          }
        }
      }
      return url.href;
    } catch { return null; }
  }

  function returnMedia(row) {
    const {artifact,nativeQuestion:card,imageChoices=[],audioChoices=[],audioArtifact}=row;
    if (!artifact && !card && !imageChoices.length && !audioChoices.length && !audioArtifact) return;
    if (audioChoices.some(choice=>!['selected','skipped'].includes(choice.status) || !choice.sources?.length) ||
        audioArtifact?.unavailable) return null;
    if (artifact && (artifact.pending || artifact.error || !artifact.sources?.length) ||
        card && (!['answered','closed','dismissed','failed'].includes(card.status) || card.draft) ||
        imageChoices.some(choice=>!['selected','skipped'].includes(choice.status) || !choice.sources?.length)) return null;
    const resources=artifact?.sources.map(mediaResource) ?? [];
    const choices=imageChoices.map(({id,status,question,options,sources})=>[id,status,question,options,sources.map(mediaResource)]);
    if (resources.includes(null) || choices.some(choice=>choice[4].includes(null))) return null;
    const media=[resources,card && [card.id,card.status,card.question,card.options,card.selected,!!card.summary],choices];
    if (audioChoices.length || audioArtifact) {
      const audio=audioArtifact?.sources.map(mediaResource) ?? [];
      const voices=audioChoices.map(({id,status,sources})=>[id,status,sources.map(mediaResource)]);
      if (audio.includes(null) || voices.some(choice=>choice[2].includes(null))) return null;
      media.push(voices,audio);
    }
    return JSON.stringify(media);
  }

  function consumedRow(row) {
    const {role, text, siteId, domKey, toolFrame, toolSource, nativeMessage, nativeSourceRejected}=row;
    return {role, text, siteId, domKey, toolFrame:toolFrame === true, toolSource, nativeMessage:nativeMessage === true,
      returnMedia:returnMedia(row),
      ...(nativeSourceRejected ? {passiveNativeHistory:true} : {})};
  }

  function receiptText(text, receipt) {
    const suffix = '\n\n' + receipt;
    // Arena renders our blank line before the receipt as a single paragraph boundary.
    if (text.endsWith(suffix) && !text.endsWith('\n' + suffix))
      return text.slice(0, -suffix.length) + '\n' + receipt;
    return text;
  }

  function changedField(old, row, ignoreToolAuthority = false) {
    if (!row) return 'presence';
    if (row.siteId !== old.siteId) return 'site ID';
    if (row.role !== old.role) return 'role';
    if (!ignoreToolAuthority && (row.toolFrame === true) !== old.toolFrame &&
        !(old.passiveNativeHistory && row.nativeMessage === true)) return 'tool authority';
    if (!ignoreToolAuthority && old.toolSource !== row.toolSource &&
        !(old.passiveNativeHistory && row.nativeMessage === true)) return 'tool source';
    if (row.text !== old.text && (!old.receipt || row.lastLine !== old.receipt ||
        receiptText(row.text, old.receipt) !== receiptText(old.text, old.receipt))) return 'text';
    return null;
  }

  function historyField(old, row, duplicateIds, readSource, outgoing, verifyEcho) {
    const field = changedField(old,row);
    if (old.originalMarkdown === undefined || (field && !['text','tool authority','tool source'].includes(field))) return field;
    if (duplicateIds.has(row.siteId)) return 'duplicate site ID';
    if (old.role === 'user') {
      if (!row.nativeMessage || row.lastLine !== old.receipt) return field || 'receipt';
      if (field && field !== 'text') return field;
      if (!verifyEcho && !old.awaitingEchoSource && (!field || row.text === old.verifiedPresentation)) return null;
      const source = readSource?.(row);
      old.awaitingEchoSource = source === undefined;
      if (old.awaitingEchoSource) return 'source unavailable';
      if (source !== old.originalMarkdown) return 'original source';
      old.verifiedPresentation = row.text;
      return null;
    }
    if (!row.nativeMessage || row.nativeQuestion || row.artifact || row.imageChoices?.length) return 'reply kind';
    if (!row.complete) return 'source unavailable';
    const prior = old.verifiedPresentation ?? old;
    const different = row.text !== prior.text || !old.passiveNativeHistory &&
      ((row.toolFrame === true) !== prior.toolFrame || row.toolSource !== prior.toolSource);
    if (!different && !outgoing) return null;
    const now = Date.now();
    if (!outgoing && old.missingSource?.text === row.text && now-old.missingSource.at < 700)
      return 'source unavailable';
    const observed = readSource?.(row,old.sourceOrigin);
    if (observed?.status === 'conflict') return 'original source';
    if (observed?.status === 'incomplete') return 'source unavailable';
    const source = old.sourceOrigin === 'stream' && observed?.status === 'unobserved'
      ? old.originalMarkdown : observed;
    if (source === undefined) {
      if (!different) return null;
      old.missingSource = {text:row.text,at:now};
      return 'source unavailable';
    }
    if (source !== old.originalMarkdown) return 'original source';
    old.missingSource = null;
    old.verifiedPresentation = {text:row.text,toolFrame:row.toolFrame===true,toolSource:row.toolSource};
    return null;
  }

  function confirmedReturnSource(old,row,readSource) {
    const source=readSource(row,old.sourceOrigin);
    if (source===old.originalMarkdown) return true;
    // Arena discards stream observations on route changes. Only this explicit
    // cache miss may use the native Copy action for the same completed message.
    if (old.sourceOrigin!=='stream' || source?.status!=='unobserved' ||
        old.role!=='assistant' || row.role!=='assistant' || !row.nativeMessage || !row.complete) return false;
    const copy=readSource(row,'copy');
    if (typeof copy!=='string') return false;
    const lineEndings=text=>text.replace(/\r\n/g,'\n').replace(/\n+$/,'');
    return lineEndings(copy)===lineEndings(old.originalMarkdown);
  }

  class Transcript {
    constructor(history) {
      this.seen = history.map(row => ({...consumedRow(row),
        // A historical frame is never dispatched under this binding.
        passiveNativeHistory: row.role==='assistant' && row.nativeMessage===true && row.siteId?.startsWith('chat-message-')}));
      this.replyRows = new WeakMap();
      this.waiting = false;
      this.pendingRows = false;
      this.fault = '';
      this.expected = null;
      this.pendingNativeCommand = null;
    }

    expect(job, text, contextId, receipt, prompt=text) {
      this.expected = { job, text, contextId, receipt, prompt, issued: Date.now() };
    }

    returnProblem(rows, readSource) {
      const sources=new Map();
      for (const [i,old] of this.seen.entries()) {
        const row=rows[i];
        if (!row || row.siteId!==old.siteId) return 'The original Arena message IDs changed.';
        if (old.returnMedia===null || returnMedia(row)!==old.returnMedia)
          return 'The original Arena images or choices changed or could not be confirmed.';
        if (old.originalMarkdown!==undefined) {
          if (!confirmedReturnSource(old,row,readSource)) return 'The original Arena message source changed or could not be confirmed.';
          sources.set(row,old.originalMarkdown);
        }
      }
      this.scan(rows,{historyOnly:true,outgoing:true,verifyEcho:true,historySource:row=>sources.get(row)});
      return this.fault || (this.historyChangedAt!=null ? 'The original Arena history could not be confirmed.' : '');
    }

    currentCommand(event,rows) {
      const receipt = this.replyRows.get(event);
      const index = receipt?.index;
      if (index === undefined || rows.length !== index+1) return false;
      const row = rows[index], old = this.seen[index];
      if (receipt.origin && receipt.command)
        return row.complete && row.nativeMessage && row.role === 'assistant' && row.siteId === receipt.siteId &&
          row.visibleToolMarker && uniqueRow(rows,row);
      return row.complete && !changedField(old,row) && (row.siteId || row.domKey === old.domKey) && uniqueRow(rows,row);
    }

    hasPendingSource(event) {
      return this.replyRows.get(event)?.source !== undefined;
    }

    acknowledgeReply(event) {
      const receipt = this.replyRows.get(event);
      if (!receipt) return;
      this.replyRows.delete(event);
      const row = this.seen[receipt.index];
      if (event.text === receipt.text && !!event.toolFrame === receipt.command && receipt.source !== undefined) {
        row.originalMarkdown = receipt.source;
        row.sourceOrigin = receipt.origin;
      } else if (receipt.origin) {
        delete row.originalMarkdown;
        delete row.sourceOrigin;
      }
      // A settled command stays passive in history even if Arena redraws its controls.
      if ((event.toolFrame || receipt.command || receipt.rejected) && row.nativeMessage && row.siteId) {
        row.passiveNativeHistory = true;
        row.publishedNativeCommand = event.toolFrame === true;
      }
    }

    finishNativeCard(row, card, answer, echo, confirmation = row.nativeQuestion) {
      if (!confirmedQuestion(card,confirmation,answer)) throw Error('Native question confirmation changed.');
      this.pendingNativeCommand = null;
      this.seen.push(consumedRow(row));
      if (echo?.role==='user' && echo.text===answer) this.seen.push(consumedRow(echo));
    }

    retireNativeQuestion(row, followup) {
      if (row) this.seen.push(consumedRow(row));
      if (followup?.role==='assistant' && followup.complete) this.seen.push(consumedRow(followup));
      this.waiting=false;
      this.waitingJob=this.replyTo=null;
      this.commandDelivery=null;
      this.pendingNativeCommand=null;
      this.expectsImage=false;
      this.expectedImages=null;
    }

    fail(reason) {
      this.fault = reason;
      if (!this.expected) return [];
      const uncertain = this.expected.job ? event('uncertain', { job: this.expected.job, text: reason })
        : event('blocked', { text: reason });
      this.expected = null;
      return [uncertain];
    }

    resumeAfterVerification() {
      this.historyChangedAt = null;
      this.verificationRecovery = true;
      this.verificationMissingSince = null;
    }

    waitForVerificationRow() {
      if (!this.verificationRecovery) return false;
      this.verificationMissingSince ??= Date.now();
      if (Date.now() - this.verificationMissingSince >= 10000) return false;
      this.historyChangedAt = this.verificationMissingSince;
      this.pendingRows = true;
      return true;
    }

    scan(rows, { generating, media, publishNativeFinal = true, historyOnly = false,
      captureSource, historySource, recoverReply, outgoing = false, verifyEcho = false, identityRows = rows }) {
      if (this.fault) return [];
      const latest = outgoing ? this.seen.findLastIndex(old=>old.role==='assistant') : -1;
      const latestEcho = verifyEcho ? this.seen.findLastIndex(old=>old.role==='user') : -1;
      const ids = new Set(), duplicateIds = new Set();
      for (const row of identityRows) {
        if (ids.has(row.siteId)) duplicateIds.add(row.siteId);
        ids.add(row.siteId);
      }
      for (const [i,old] of this.seen.entries()) {
        const field = historyField(old,rows[i],duplicateIds,historySource,i===latest,i===latestEcho);
        if (!field) continue;
        if (this.verificationRecovery && field === 'presence') {
          if (this.waitForVerificationRow()) return [];
        } else if (field === 'source unavailable' || field !== 'original source' && (
          (this.waitingJob && old.nativeMessage) || (old.publishedNativeCommand && field === 'text'))) {
          this.historyChangedAt ??= Date.now();
          if (Date.now() - this.historyChangedAt < 10000) {
            this.pendingRows = true;
            return [];
          }
        }
        this.historyChangedAt = null;
        this.transcriptChanged = field === 'original source';
        const next = this.transcriptChanged ? 'The current turn stopped.' : 'Inspect the chat and reconnect.';
        return this.fail('The transcript changed at row ' + (i+1) + ' (' + field + '). ' + next);
      }
      this.historyChangedAt = null;
      if (historyOnly) return [];
      const pending = this.pendingNativeCommand;
      const candidate = rows[this.seen.length];
      let recovered;
      const readFinal = row => {
        if (recoverReply && row !== recovered && publishNativeFinal && !generating && row.complete &&
            row.nativeMessage && row === rows.at(-1) && uniqueRow(identityRows,row,this.seen)) {
          recovered = row;
          recoverReply(row,this.commandDelivery);
        }
      };
      if (pending && !candidate && this.waitForVerificationRow()) return [];
      this.verificationRecovery = false;
      if (pending) {
        const field = changedField(pending, candidate, true);
        if (field) {
          // A rendered preview has no source yet. Let the same native reply finish
          // rendering, then select its source under the normal publication checks.
          const samePreview = field === 'text' && recoverReply && pending.nativeMessage && candidate?.nativeMessage &&
            pending.siteId && pending.siteId === candidate.siteId && candidate === rows.at(-1) &&
            uniqueRow(identityRows,candidate,this.seen);
          if (samePreview && (generating || !publishNativeFinal || !candidate.complete)) {
            this.pendingRows = true;
            return [];
          }
          if (samePreview) readFinal(candidate);
          if (!samePreview || !(candidate.sourceOrigin && candidate.toolFrame || candidate.nativeSourceRejected))
            return this.fail('The current native command changed before publication (' + field + '). Inspect the chat and reconnect.');
        }
        readFinal(candidate);
        if (!candidate.toolFrame && !candidate.nativeSourceRejected &&
            rows.length === this.seen.length + 1 && uniqueRow(rows,candidate,this.seen)) {
          pending.authorityMissingAt ??= Date.now();
          if (Date.now() - pending.authorityMissingAt >= 10000)
            return this.fail('The current native command did not regain visible authority before publication. Inspect the chat and reconnect.');
          this.pendingRows = true;
          return [];
        }
        pending.authorityMissingAt = null;
      }
      const output = [];
      for (let i = this.seen.length; i < rows.length; i++) {
        const row = rows[i];
        let end = i+1;
        if (row.role === 'unknown' && row.nativeMessage && row.siteId && (this.waiting || this.expected)) {
          // Arena can mount the native message shell and its status before its role-specific prose.
          if (i !== rows.length - 1 || rows.slice(0,i).some(other => other.siteId === row.siteId))
            return output.concat(this.fail('Cannot identify the new Arena message in order. Inspect the chat and reconnect.'));
          if (generating) this.unknownIdleSince = null;
          else {
            this.unknownIdleSince ??= Date.now();
            if (Date.now() - this.unknownIdleSince >= 30000)
              return output.concat(this.fail('Arena did not identify the new message after generation stopped. Inspect the chat and reconnect.'));
          }
          break;
        }
        this.unknownIdleSince = null;
        if (this.waiting && row.multipleFinalBodies && (!row.complete || !row.text)) {
          if (generating) this.mixedIdleSince = null;
          else {
            this.mixedIdleSince ??= Date.now();
            if (Date.now()-this.mixedIdleSince>=30000)
              return output.concat(this.fail('Arena row '+(i+1)+' has multiple answer sections without a stable visible completion. Inspect the chat and reconnect.'));
          }
          break;
        }
        this.mixedIdleSince = null;
        if (row.role === 'assistant' && this.waiting && (row.artifact || row.generationHint)) this.expectsImage ||= true;
        const nativeUploadTurn = !this.expected && row.role==='user' && row.nativeMessage && row.siteId &&
          rows[i+1]?.role==='assistant';
        const nativeMedia = media && this.waiting && row.role==='assistant' && row.nativeMessage &&
          (row.artifact || this.expectedImages);
        if (!row.text && !row.images?.length && !row.audioArtifact && !nativeUploadTurn && !nativeMedia) break;
        let receipt, submittedSource, pendingProof;
        if (row.role === 'user') {
          if (this.expected?.receipt) {
            if (!uniqueRow(identityRows,row) || row.lastLine !== this.expected.receipt) {
              // The bubble can mount before its final paragraph. Stop at this
              // row until it settles, another turn appears, or the timer expires.
              if (i === rows.length - 1) break;
              return output.concat(this.fail('The expected delivery receipt is missing from the new user message.'));
            }
            if (row.nativeMessage) {
              receipt = this.expected.receipt;
              const original = historySource?.(row);
              if (typeof original === 'string' && original.trimEnd().endsWith('\n'+receipt)) submittedSource = original;
            }
          } else if ((this.expected?.job || this.expected?.contextId) && ![row.text,row.echoMarkdown].includes(this.expected.text.trim())) {
            return output.concat(this.fail('A different user message appeared before the expected echo.'));
          }
          const fields = {text:this.expected?.receipt ? this.expected.text : row.text};
          const stamped = /^Bridge delivery ([a-f\d]{32})$/.exec(this.expected?.receipt ?? '')?.[1];
          if (!this.expected?.job && stamped) fields.id = stamped;
          if (this.expected?.contextId) fields.contextId = this.expected.contextId;
          const submitted = this.expected?.job ? event('sent', { job: this.expected.job }) : event('user', fields);
          output.push(submitted);
          this.waitingJob = this.expected?.job;
          this.replyTo = this.waitingJob || submitted.id;
          this.commandDelivery = stamped === this.replyTo ? stamped : null;
          const prompt = userPrompt(this.expected?.prompt || row.text);
          this.expectsImage = requestsImage(prompt);
          this.expectedImages = this.expectsImage ? requestedImageCount(prompt) : null;
          this.expected = null;
          this.waiting = true;
        } else if (row.role === 'assistant' && this.waiting) {
          readFinal(row);
          if (row.sourceIncomplete) {
            if (this.incompleteSource?.siteId !== row.siteId)
              this.incompleteSource = {siteId:row.siteId,since:Date.now()};
            if (Date.now() - this.incompleteSource.since < 10000) break;
          }
          const allowTool = row.toolFrame === true && !!this.commandDelivery && this.replyTo === this.commandDelivery &&
            this.expectsImage !== 'explicit' && i === rows.length-1 && uniqueRow(rows,row,this.seen);
          const reportedFailure = this.expectsImage && !allowTool && imageUnavailable(row.text);
          const settledAudioQuestion=row.audioArtifact && row.nativeQuestion?.status==='answered';
          const result = !allowTool && (!row.nativeQuestion || settledAudioQuestion) && !row.nativeSourceRejected ?
            media?.(i,this) : undefined;
          if (result === null) break;
          if (result === undefined) {
            if (generating || !row.complete || row.audioArtifact ||
                row.artifactsPending && !(row.artifact?.progressOnly && reportedFailure)) break;
            if (this.expectsImage && !row.images?.length && !allowTool && !reportedFailure && !row.nativeSourceRejected) break;
          } else end = result.end;
          if (row.nativeMessage && !publishNativeFinal) {
            if (allowTool) this.pendingNativeCommand = consumedRow(row);
            break;
          }
          const fields = { text: result?.text ?? row.responseText ?? row.text, replyTo:this.replyTo };
          const images = result?.images ?? row.images;
          if (result?.audio?.length) {
            if (!this.replyTo) return output.concat(this.fail('Cannot associate the generated audio with a submitted user turn.'));
            fields.audio = result.audio;
          }
          if (images?.length) {
            if (!this.replyTo) return output.concat(this.fail('Cannot associate the generated image with a submitted user turn.'));
            fields.images = images;
          }
          else if (allowTool && !fields.audio) {
            fields.toolFrame = true;
            if (row.toolSource !== undefined) fields.toolSource = row.toolSource;
          }
          const reply = event('assistant', fields);
          const source = !result && !images?.length && row.nativeMessage && row.complete && row.siteId &&
            !row.artifact && !row.nativeQuestion && !row.imageChoices?.length && i===rows.length-1 && uniqueRow(rows,row)
            ? captureSource?.(row) : undefined;
          if (fields.toolFrame || row.nativeSourceRejected || typeof source === 'string' && source.length)
            this.replyRows.set(reply,{index:i,source,origin:row.sourceOrigin,siteId:row.siteId,text:fields.text,
              command:!!fields.toolFrame,rejected:row.nativeSourceRejected});
          if (row.sourceOrigin && typeof source === 'string')
            pendingProof = {originalMarkdown:source,sourceOrigin:row.sourceOrigin};
          output.push(reply);
          this.incompleteSource = null;
          this.waiting = false;
          this.waitingJob = null;
          this.replyTo = null;
          this.commandDelivery = null;
          this.pendingNativeCommand = null;
          this.expectsImage = false;
          this.expectedImages = null;
        } else {
          return output.concat(this.fail('Cannot pair this reply with a new user turn.'));
        }
        this.seen.push(...rows.slice(i,end).map(consumed=>({...consumedRow(consumed),receipt,...pendingProof,
          ...(submittedSource === undefined ? {} : {originalMarkdown:submittedSource})})));
        i=end-1;
      }
      this.pendingRows = this.seen.length < rows.length;
      if (!this.pendingRows) this.unknownIdleSince = null;
      return output;
    }
  }
  return { conversation, awayAgentRoute, event, delivery, pairingSettlement, Transcript, validQuestion, sameQuestion, confirmedQuestion,
    imageUnavailable, maxGeneratedImages };
})();

if (typeof module !== 'undefined') module.exports = ArenaBridge;
