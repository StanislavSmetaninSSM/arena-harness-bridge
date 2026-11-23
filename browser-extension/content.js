'use strict';

(() => {
  const page = new ArenaPage(document);
  const pageKey = crypto.randomUUID();
  const unpublished = new WeakMap();
  const pendingMedia = new WeakMap();
  const finalSettleMs = 900;
  const mediaSettleMs = 2400;
  const mediaIdleLimitMs = 120000;
  const mediaTailWaitMs = 12000;
  const here = () => ArenaBridge.conversation(location.href);
  let prepared, session, skill, processing = false;
  let status = 'Open the extension to bind this conversation.';

  async function rpc(s, type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({ type, pageKey, chat: s.chat, binding: s.binding,
      recoveredTranscript:s.recoveredTranscript, ...fields });
    if (!reply?.ok) throw Error(reply?.error || 'Terminal did not acknowledge the request.');
    return reply;
  }

  function suspend(s, issue, job = s.activeJob) {
    s.outbox = s.outbox.filter(event => {
      if (!unpublished.has(event)) return true;
      job ??= unpublished.get(event);
      unpublished.delete(event);
      return false;
    });
    if (s.problem) {
      if (job && !s.problem.job) s.problem.job = job;
      return;
    }
    const transcriptChanged = s.log.transcriptChanged && issue.kind === 'blocked' && issue.text === s.log.fault;
    s.problem = ArenaBridge.event(issue.kind, { text: issue.text, ...(job ? {job} : {}),
      ...(transcriptChanged ? {transcriptChanged:true} : {}) });
    s.outbox.push(s.problem);
    s.log.fault = issue.text;
    s.log.expected = null;
  }

  function sameImages(first, second) {
    return first?.images && !first.pending && !second?.pending && first.images.length === second?.images?.length
      && first.images.every((img,i)=>img===second.images[i] && first.sources[i]===second.sources[i]);
  }

  function mediaShape(rows) {
    return JSON.stringify(rows.map(row=>[row.siteId,row.role,row.text,row.complete,row.postImageProse,row.artifact?.pending,
      row.artifact?.error,row.artifact?.sources]));
  }

  function captureResult(s,row) {
    if (!row?.complete || !s.log.waiting || !s.log.replyTo || s.capture || s.log.fault ||
        s.media?.owner===s.log.replyTo) return;
    const artifact=row.artifact;
    if (!artifact && !s.log.expectsImage) return;
    if (!s.imageWait || s.imageWait.owner!==s.log.replyTo) s.imageWait={owner:s.log.replyTo,since:Date.now()};
    if (!artifact) {
      if (Date.now()-s.imageWait.since>120000) suspend(s,{kind:'blocked',text:'Arena finished its text but no verified generated image appeared. Inspect the reply and reconnect.'});
      return;
    }
    if (artifact.error) { suspend(s,{kind:'blocked',text:artifact.error}); return; }
    if (artifact.pending) {
      try { if (artifact.images?.length) ArenaGeneratedImages.activate(artifact); }
      catch (error) { suspend(s,{kind:'blocked',text:error.message}); return; }
      if (Date.now()-s.imageWait.since>300000) suspend(s,{kind:'blocked',text:'Arena did not load the native generated image. Inspect its viewer and reconnect.'});
      return;
    }
    const owner=s.log.replyTo, siteId=row.siteId;
    s.capture=true;
    ArenaGeneratedImages.encode(artifact).then(images=>{
      if (s!==session || s.chat!==here() || s.departed || s.log.replyTo!==owner || s.log.fault) return;
      const current=page.rows()[s.log.seen.length];
      if (!current?.complete || current.siteId!==siteId || !sameImages(artifact,current.artifact)) return;
      s.pictures={owner,siteId,artifact,images};
      collect(s);
    }).catch(()=>{
      if (s===session && s.chat===here() && s.log.replyTo===owner)
        suspend(s,{kind:'blocked',text:'The generated image could not be read from the completed Arena reply.'});
    }).finally(()=>{s.capture=false;});
  }

  function mediaReply(s,rows,state,index,log,publish) {
    const tail=rows.slice(index);
    const requested=log.expectedImages;
    const first=tail[0];
    if (!log.replyTo || !first.nativeMessage || !first.siteId ||
        (!requested && !tail.some(row=>row.artifact?.images?.length)) ||
        (!requested && tail.length===1 && !first.siteId.startsWith('chat-message-')))
      return undefined;

    if (!s.media || s.media.owner!==log.replyTo) s.media={owner:log.replyTo,since:Date.now()};
    const batch=s.media;
    const stop=text=>{suspend(s,{kind:'blocked',text});return null;};
    if (tail.some(row=>!['assistant','unknown'].includes(row.role) || !row.nativeMessage || !row.siteId ||
        row.nativeQuestion || row.toolFrame ||
        rows.filter(other=>other.siteId===row.siteId).length!==1))
      return stop('Cannot verify the generated images belong to one Arena reply. Inspect the chat and reconnect.');
    const artifact={images:[],sources:[]};
    let pending=false;
    for (const row of tail) {
      const part=row.artifact;
      if (!part) continue;
      if (part.error) return stop(part.error);
      pending ||= !!part.pending && !part.progressOnly;
      artifact.images.push(...(part.images ?? []));
      artifact.sources.push(...(part.sources ?? []));
      if (part.pending && part.images?.length) {
        try { ArenaGeneratedImages.activate(part); }
        catch (error) { return stop(error.message); }
      }
    }
    const count=artifact.sources.length;
    if (new Set(artifact.sources).size!==count || count>ArenaBridge.maxGeneratedImages)
      return stop('Arena returned too many generated images or reused an image source in the same turn.');
    const key=mediaShape(tail);
    if (batch.key!==key) {
      if (batch.artifact?.sources.some((source,i)=>artifact.sources[i]!==source))
        return stop('The generated images changed before delivery. Inspect the original Arena reply.');
      batch.key=key;
      batch.since=Date.now();
      if (!sameImages(batch.artifact,artifact)) batch.images=null;
    }
    if (state.generating) batch.since=Date.now();
    const elapsed=Date.now()-batch.since;
    const observed=requested ? `${count} of ${requested} requested` : String(count);
    // A native shell can mount before its role or final content. Wait only while it is changing or active.
    if (state.generating || tail.some(row=>!row.complete || row.role==='unknown')) {
      if (elapsed<mediaIdleLimitMs) return null;
      return stop(`Arena stopped with ${observed} images visible and an unfinished reply. Inspect the chat and reconnect.`);
    }
    const last=tail.at(-1), finalText=(last.artifact ? last.postImageProse ?? '' : last.text).trim();
    const short=!!requested && count<requested;
    const failure=tail.some(row=>ArenaBridge.imageUnavailable(row.text));
    pending ||= tail.some(row=>row.artifact?.progressOnly) && !count && !failure;
    if (pending && elapsed<mediaIdleLimitMs || elapsed<mediaSettleMs) return null;
    if (short && !failure && elapsed<mediaIdleLimitMs) return null;
    // Allow a trailing native prose row to arrive after the last image. A completed
    // image-only turn can still finish when Arena leaves the transcript idle.
    if (requested && !short && !finalText && elapsed<mediaTailWaitMs) return null;
    if (pending)
      return stop(`Arena did not complete the batch or load its native pictures. Observed ${observed} images.`);

    if (!count || batch.images && sameImages(batch.artifact,artifact)) {
      if (!publish) return null;
      const prose=tail.map(row=>row.text).filter(Boolean);
      if (short) prose.push(`Arena returned ${count} of ${requested} requested images.`);
      if (count) batch.delivery={index,key,job:s.activeJob};
      return {end:rows.length,text:prose.join('\n\n'),images:batch.images};
    }
    if (!s.capture) {
      s.capture=true;
      ArenaGeneratedImages.encode(artifact).then(images=>{
        if (s!==session || s.chat!==here() || s.departed || s.media!==batch || batch.key!==key ||
            log.replyTo!==batch.owner || log.fault) return;
        batch.artifact=artifact;
        batch.images=images;
      }).catch(()=>{
        if (s===session && s.chat===here() && log.replyTo===batch.owner && s.media===batch && batch.key===key)
          stop('The generated images could not be read from the completed Arena reply.');
      }).finally(()=>{s.capture=false;collect(s);});
    }
    return null;
  }

  function sameSources(left, right) {
    return !!left && !!right && left.length===right.length && left.every((source,index)=>source===right[index]);
  }

  function nextImageChoice(row) {
    return row?.imageChoices?.find(card=>!['skipped','selected'].includes(card.status));
  }

  function imageChoiceState(card, pending) {
    if (card?.status==='selected') {
      const index=pending.sources.indexOf(card.sources[0]);
      return index===-1 ? null : {...pending.wire,status:'answered',selected:pending.wire.options[index]};
    }
    if (card?.status==='skipped' && sameSources(card.sources,pending.sources))
      return {...pending.wire,status:'answered',selected:'Skip'};
    return card;
  }

  function nativeQuestionTurn(s, rows, state) {
    const index = s.log.seen.length, row = rows[index];
    let pending = s.question;
    const question = row?.nativeQuestion;
    const image = pending?.sources ? row?.imageChoices?.find(card=>card.id===pending.wire.id)
      : !pending && question?.status!=='active' ? nextImageChoice(row) : null;
    const gallery = !!(pending?.sources || image);
    const card = pending?.sources ? imageChoiceState(image,pending) : image || question;
    const currentTurn = rows.length===index+1 || gallery && rows.slice(index+1).every(next=>next.role==='assistant' && next.nativeMessage);
    if (!pending && (!card || !gallery && card.status!=='active' || !s.log.waiting || !currentTurn)) {
      s.questionCandidate=null;
      return false;
    }
    // The active widget belongs to an unfinished assistant message. Keep it outside
    // consumed history while checking the entire previously acknowledged prefix.
    s.log.scan(rows.slice(0,index),{...state,historyOnly:true});
    if (s.log.fault) { suspend(s,{kind:'blocked',text:s.log.fault}); return true; }
    if (s.log.historyChangedAt != null) return true;
    if (pending && !row && s.log.verificationRecovery) {
      if (s.log.waitForVerificationRow()) return true;
      suspend(s,{kind:pending.answerJob ? 'uncertain' : 'blocked',
        text:'The original Arena question did not return after Security Verification. Inspect the conversation.'},
        pending.answerJob || pending.origin);
      return true;
    }
    s.log.verificationRecovery = false;
    s.log.pendingRows = true;
    if (!pending) {
      if (gallery && card.status==='invalid') {
        suspend(s,{kind:'blocked',text:'Arena image choices changed or include an unreadable image.'},s.log.waitingJob);
        return true;
      }
      const wire = {id:card.id,question:card.question,options:[...card.options]};
      if (!ArenaBridge.sameQuestion(s.questionCandidate?.wire,wire) ||
          gallery && !sameSources(s.questionCandidate?.sources,card.sources)) {
        s.questionCandidate={wire,sources:gallery ? card.sources : undefined,since:Date.now()};
        return true;
      }
      const candidate=s.questionCandidate;
      if (Date.now()-candidate.since < 900) return true;
      const origin = s.log.waitingJob;
      const interactive = s.supportsNativeQuestions && !!origin;
      if (gallery && origin && (!s.supportsImageChoices || candidate.failed)) {
        const text=candidate.failed ? 'The Arena image previews could not be read.' : 'Update the Desktop companion to choose Arena images.';
        suspend(s,{kind:'blocked',text},origin);
        return true;
      }
      if (gallery && card.status!=='active') {
        if (Date.now()-candidate.since>120000)
          suspend(s,{kind:'blocked',text:'Arena did not finish loading its image previews.'},origin);
        else if (card.sources.every(Boolean)) {
          try { ArenaGeneratedImages.activate(card); }
          catch (error) { suspend(s,{kind:'blocked',text:error.message},origin); }
        }
        return true;
      }
      if (gallery && interactive && !candidate.previews) {
        if (!candidate.capturing) {
          candidate.capturing=true;
          ArenaGeneratedImages.encode(card).then(previews=>{candidate.previews=previews;},()=>{candidate.failed=true;});
        }
        return true;
      }
      const event = ArenaBridge.event('assistant',{text:row.text,...(interactive ? {nativeQuestion:wire,replyTo:origin} : {})});
      if (gallery && interactive) event.choicePreviews=candidate.previews;
      pending = s.question = {wire,event,origin,siteId:row.siteId,initialProse:row.prose,passive:!interactive,
        sources:gallery ? candidate.sources : undefined};
      unpublished.set(event,origin);
      s.outbox.push(event);
      return true;
    }
    const same = ArenaBridge.sameQuestion(pending.wire,card) &&
      (!gallery || card.status!=='active' || sameSources(pending.sources,card.sources));
    const confirmed = ArenaBridge.confirmedQuestion(pending.wire,card,pending.answer);
    const summary = card?.summary && card.id===pending.wire.id && card.question===pending.wire.question &&
      pending.wire.options.includes(card.selected);
    const finalProse = row?.nativeMessage && row.siteId===pending.siteId && row.role==='assistant' && !row.toolFrame &&
      row.prose && row.prose!==pending.initialProse && row.complete && !state.generating;
    const dismissed = card?.status==='dismissed' && card.id===pending.wire.id && row.siteId===pending.siteId;
    pending.closed = dismissed || (same || summary) && ['failed','closed','answered'].includes(card.status);
    if (!pending.dispatched && (!same || card.status!=='active' || !currentTurn)) {
      s.outbox = s.outbox.filter(event=>event!==pending.event);
      unpublished.delete(pending.event);
      s.question = s.questionCandidate = null;
      return false;
    }
    if (!pending.answerJob) {
      if (pending.passive && (pending.closed && row.complete || !card && finalProse || !row && state.ready)) {
        const next=rows[index+1];
        const mayFollow = !next && (!row || card?.status==='answered' || dismissed);
        if (next?.role==='assistant' && (!next.complete || state.generating)) return true;
        if (mayFollow) {
          if (!state.ready) {pending.idleSince=null;return true;}
          pending.idleSince ??= Date.now();
          if (Date.now()-pending.idleSince<650) return true;
        }
        s.log.retireNativeQuestion(row,next);
        if (mayFollow) s.passiveFollowupIndex=s.log.seen.length;
        s.question = s.questionCandidate = null;
        return false;
      }
      if (pending.closed || !same && card || !currentTurn) pending.expired = true;
      return true;
    }
    if (!pending.confirmed) {
      if (confirmed) {
        pending.confirmed = true;
        pending.confirmedAt=Date.now();
        s.outbox.push(ArenaBridge.event('sent',{job:pending.answerJob}));
        s.log.replyTo = s.log.waitingJob = pending.answerJob;
        s.log.commandDelivery = null;
        s.log.expectsImage = false;
        s.log.expectedImages = null;
      } else {
        if (!same || card.status!=='active' || Date.now()-pending.clickedAt >= 15000)
          suspend(s,{kind:'uncertain',text:'Arena did not confirm the selected option on the original question. Inspect the conversation.'},pending.answerJob);
        return true;
      }
    }
    if (confirmed && (nextImageChoice(row) || gallery && question?.status==='active')) {
      s.question = s.questionCandidate = null;
      return true;
    }
    if (confirmed && rows.length>index+1) {
      s.log.finishNativeCard(gallery ? {...row,nativeQuestion:card} : row,pending.wire,pending.answer,rows[index+1]);
    } else if ((confirmed || !card) && finalProse) {
      row.responseText=row.prose;
    } else {
      if (Date.now()-pending.confirmedAt>120000)
        suspend(s,{kind:'blocked',text:'Arena confirmed the selection but has not shown a verifiable following reply.'},pending.answerJob);
      return true;
    }
    s.question = s.questionCandidate = null;
    return gallery && !!nextImageChoice(rows[s.log.seen.length]);
  }

  function settleFinal(s,row) {
    if (row?.complete && (row.nativeMessage || row.siteId?.startsWith('chat-message-'))) {
      if (s.finalId!==row.siteId || s.finalText!==row.text || s.finalToolFrame!==row.toolFrame) {
        s.finalId=row.siteId;
        s.finalText=row.text;
        s.finalToolFrame=row.toolFrame;
        s.finalAt=Date.now();
      }
      // A preliminary caption can be mounted before the native image card.
      if (!row.artifact && Date.now()-s.finalAt<finalSettleMs) row.complete=false;
      if (s.pictures?.owner===s.log.replyTo && s.pictures?.siteId===row.siteId
          && sameImages(s.pictures?.artifact,row.artifact)) {
        row.images=s.pictures.images;
        row.artifactsPending=false;
      }
    }
  }

  function collect(s,publishNativeFinal=false,outgoing=false,verifyEcho=false) {
    if (s !== session || s.chat !== here() || s.departed || s.log.fault || s.publishingReply) return;
    const state = page.state();
    if (state.verification) {
      s.verificationSince ??= Date.now();
      return;
    }
    if (s.verificationSince != null) {
      const duration = Math.max(0, Date.now()-s.verificationSince);
      if (s.log.expected) s.log.expected.issued += duration;
      if (s.question?.clickedAt != null) s.question.clickedAt += duration;
      if (s.question?.confirmedAt != null) s.question.confirmedAt += duration;
      s.verificationSince = null;
      s.log.resumeAfterVerification();
    }
    if (state.issue && !state.issue.account) { suspend(s, state.issue); return; }
    const rows=page.rows();
    const scanState = {...state,outgoing,verifyEcho,identityRows:rows,historySource:row=>page.historyReplySource?.(row)};
    const oldIndex=s.log.seen.length;
    settleFinal(s,rows.slice(oldIndex).find(row=>row.role==='assistant'));
    if (s.passiveFollowupIndex===oldIndex && !s.log.waiting && !s.log.expected && rows[oldIndex]) {
      const tail=rows[oldIndex];
      if (tail.role==='assistant') {
        s.log.scan(rows.slice(0,oldIndex),{...scanState,historyOnly:true});
        if (s.log.fault) {suspend(s,{kind:'blocked',text:s.log.fault});return;}
        if (s.log.historyChangedAt != null) return;
        if (!tail.complete || state.generating) {s.log.pendingRows=true;return;}
        s.log.retireNativeQuestion(null,tail);
      }
      s.passiveFollowupIndex=null;
    }
    if (nativeQuestionTurn(s,rows,scanState)) return;
    if (oldIndex!==s.log.seen.length) settleFinal(s,rows[s.log.seen.length]);
    // Keep a native final mutable until the tick can publish it after earlier events.
    const events = s.log.scan(rows, {...scanState,publishNativeFinal,captureSource:row=>page.captureReplySource?.(row),
      recoverReply:(row,delivery)=>page.recoverToolReply?.(row,delivery),
      media:(index,log)=>mediaReply(s,rows,state,index,log,publishNativeFinal)});
    if (s.log.historyChangedAt != null) return;
    if (s.log.transcriptChanged) {
      suspend(s,{kind:'blocked',text:s.log.fault},events.find(event=>event.kind==='uncertain')?.job ?? s.activeJob);
      return;
    }
    if (!state.generating) captureResult(s,rows[s.log.seen.length]);
    s.outbox.push(...events);
    for (const event of events) if (event.kind === 'user' && event.contextId) {
      s.appliedContext = event.contextId;
      if (s.context?.id === event.contextId) s.context = null;
    }
    for (const event of events) {
      if (event.kind === 'assistant') unpublished.set(event,s.activeJob);
      if (event.kind==='assistant' && event.images && s.media?.delivery) pendingMedia.set(event,s.media.delivery);
      if (event.kind === 'assistant' || event.kind === 'user') s.activeJob = null;
    }
    if (s.log.fault && !events.some(event => event.kind === 'uncertain' || event.kind === 'blocked'))
      suspend(s, {kind:'blocked',text:s.log.fault});
    if (events.some(event => event.kind === 'assistant')) {
      s.pictures=null;
      s.imageWait=null;
      s.media=null;
      s.settling = true;
      s.settleField = null;
    }
    const expected=s.log.expected;
    if (expected && Date.now() - expected.issued > 15000) {
      if (state.issue?.account) { suspend(s,state.issue,expected.job); return; }
      const draftKept=expected.receipt && state.value===expected.text+'\n\n'+expected.receipt;
      const reason=draftKept
        ? 'Arena kept the draft in its composer after Send. No matching message appeared in the chat.'
        : 'Send was clicked but the matching user message has not been confirmed. Inspect the chat.';
      s.outbox.push(...s.log.fail(reason));
    }
  }

  function messageStatus(s, state) {
    if (state.verification) return 'Waiting for you to complete Arena Security Verification in Chrome.';
    if (s.log.fault) return s.log.fault;
    if (s.log.historyChangedAt != null) return 'Waiting for Arena to restore the conversation history.';
    if (s.log.expected) return 'Waiting for the sent message to appear.';
    if (s.imageWait) return 'Waiting for the native generated image from this Arena reply.';
    if (s.media) return 'Waiting for the Arena image batch and final reply.';
    if (s.log.waiting || s.log.pendingRows || state.generating) return 'Waiting for a completed Arena turn.';
    if (state.upload) return 'An attachment is present in the browser draft.';
    if (state.review) return 'Waiting for Arena to restore the composer after the review panel.';
    if (!state.field || !state.idle) return 'Waiting for an idle Arena composer.';
    if (state.value) return 'Browser draft is occupied.';
    return 'Ready.';
  }

  function changed(s, note) {
    if (s.lastNote === note) return;
    s.lastNote = note;
    s.outbox.push(ArenaBridge.event('busy', { text: note }));
  }

  function guard(s, count, outgoing=false) {
    collect(s,false,outgoing);
    return session === s && !prepared && s.chat === here() && !s.departed && !s.log.fault && !s.publishingReply
      && s.verificationSince == null && s.log.historyChangedAt == null && !s.log.expected && !s.log.waiting && !s.log.pendingRows && s.log.seen.length === count;
  }

  function recoveryHistory(s) {
    if (session !== s || prepared || s.departed || s.chat !== here()) return null;
    const state = page.state();
    if (!state.ready && !(state.reviewAction && !state.value && !state.upload && !state.issue &&
        !state.generating && !state.verification)) return null;
    const rows = page.rows(), ids = rows.map(row => row.siteId).filter(Boolean);
    const last = rows.at(-1);
    if (last?.role !== 'assistant' || !last.complete || !(last.text || last.artifact || last.imageChoices?.length) ||
        (last.nativeQuestion && !['answered','closed','dismissed','failed'].includes(last.nativeQuestion.status)) ||
        last.imageChoices?.some(choice => !['selected','skipped'].includes(choice.status)) ||
        new Set(ids).size !== ids.length ||
        rows.some(row => !['user','assistant'].includes(row.role))) return null;
    return {rows, ready:state.ready};
  }

  async function recoverTranscript(s) {
    if (!s.problem?.transcriptChanged || !recoveryHistory(s)) return;
    const id = s.problem.id;
    const response = await rpc(s,'poll',{ready:false,recoverTranscript:id});
    const current = response.recoverTranscript === true && recoveryHistory(s);
    if (!current) return;
    if (!current.ready) { page.continueWork(); return; }
    // Consume the current history passively. Only a later poll can lease the new Desktop message.
    session = {chat:s.chat,binding:s.binding,recoveredTranscript:id,log:new ArenaBridge.Transcript(current.rows),outbox:[]};
    status = 'Ready.';
  }

  async function tick() {
    const s = session;
    if (prepared && prepared.expires < Date.now()) prepared = null;
    if (skill && !skill.applying && Date.now() > skill.expires) skill = null;
    if (processing || !s || prepared || skill || s.manual) return;
    processing = true;
    try {
      if (s.chat !== here() || s.departed) {
        s.departed = true;
        status = 'Tab changed conversation. Reconnect from the original chat.';
        if (!s.reportedDeparture) { await rpc(s, 'depart'); s.reportedDeparture = true; }
        return;
      }
      // A native answer may still redraw while earlier events are in flight.
      collect(s,!s.outbox.length && s.log.waiting && !s.log.expected);
      const observed = page.state();
      status = messageStatus(s, observed);
      if (observed.verification) {
        if (s.lastNote !== status) {
          await rpc(s,'event',{event:ArenaBridge.event('busy',{text:status})});
          s.lastNote = status;
        }
        return;
      }
      if (!s.log.fault && s.log.historyChangedAt != null) return;
      changed(s, status);
      while (s.outbox.length) {
        if (session !== s || s.chat !== here() || s.departed || prepared) return;
        if (page.state().verification) { collect(s); return; }
        const next = s.outbox[0];
        const media=pendingMedia.get(next);
        if (media && mediaShape(page.rows().slice(media.index))!==media.key) {
          s.outbox.shift();
          suspend(s,{kind:'blocked',text:'The generated images changed before delivery. Inspect the original Arena reply.'},media.job);
          continue;
        }
        if (unpublished.has(next) || next.toolFrame) {
          collect(s,false,false,next.kind==='assistant');
          if (s.outbox[0] !== next) continue;
          if (s.log.historyChangedAt != null) return;
          // Retrying an unacknowledged event can be its first successful publication.
          if (next.toolFrame) {
            const rows = page.rows();
            const current = !s.log.fault && !s.log.expected && s.log.currentCommand(next,rows) &&
              !s.outbox.some(event => event.kind==='user' || event.kind==='sent');
            if (next.toolSource !== undefined && (!current || !page.confirmToolReply(rows.at(-1)))) {
              // Keep the event ID so a lost acknowledgement cannot cause a second action.
              next.text = 'Arena changed or lost the original tool reply. Check the conversation before retrying.';
              delete next.toolSource;
              delete next.toolFrame;
            }
            if (!current) delete next.toolFrame;
          }
          unpublished.delete(next);
          if (s.question?.event === next) {
            s.question.dispatched = true;
            s.activeJob = null;
          }
        }
        const command = next.toolFrame === true;
        const verifyAfterAck = command || s.log.hasPendingSource(next);
        s.publishingReply = verifyAfterAck;
        let receipt;
        try {
          receipt = await rpc(s, 'event', { event: next, ...(next.nativeQuestion ? {supportsNativeQuestions:true} : {}) });
        } finally {
          s.publishingReply = false;
        }
        s.log.acknowledgeReply(next);
        if (s.question?.event===next) s.question.passive = !(receipt.nativeQuestionHandled==='interactive' &&
          receipt.nativeQuestionId===s.question.wire.id && receipt.replyTo===s.question.origin);
        s.outbox.shift();
        if (verifyAfterAck) {
          collect(s);
          if (s.log.historyChangedAt != null) return;
        }
      }
      if (s.log.fault) { await recoverTranscript(s); return; }
      const count = s.log.seen.length;
      const state = page.state();
      if (state.verification) { collect(s); return; }
      // A credit limit blocks the next Send. Publish any already accepted response first.
      if (state.issue?.account && !s.log.waiting && !s.log.expected && !s.question) {
        suspend(s,state.issue);
        return;
      }
      if (state.review && !s.question && guard(s, count) && page.continueWork()) return;
      if (s.settling) {
        if (!state.ready) s.settleField = null;
        else if (s.settleField !== state.field) { s.settleField = state.field; s.settleSince = Date.now(); }
        else if (Date.now() - s.settleSince >= 650) s.settling = false;
      }
      const nativeQuestionId = s.question?.dispatched && !s.question.passive && !s.question.answerJob ? s.question.wire.id : undefined;
      const nativeQuestionClosed = Boolean(nativeQuestionId && s.question.closed);
      const ready = !s.question && state.ready && !s.settling && !s.log.waiting && !s.log.expected && !s.log.pendingRows;
      const { job, context, supportsNativeQuestions, supportsImageChoices, nativeQuestionClosed:closedId } = await rpc(s, 'poll', {
        ready, supportsPngBatch:true, supportsNativeQuestions:true, nativeQuestionId, nativeQuestionClosed
      });
      if (session !== s || prepared) return;
      s.supportsNativeQuestions = supportsNativeQuestions === true;
      s.supportsImageChoices = supportsImageChoices === true;
      if (nativeQuestionClosed && closedId===nativeQuestionId && s.question?.wire.id===closedId && !job) {
        s.question.passive = true;
        collect(s);
      }
      if (context !== undefined && !s.manual) updateContext(s,context);
      if (!job) return;
      s.activeJob = job.id;
      s.sending = true;
      try {
        if ('nativeAnswer' in job) {
          collect(s,false,true);
          const pending = s.question, answer = job.nativeAnswer, composer=page.state();
          if (composer.issue?.account) { suspend(s,composer.issue,job.id); return; }
          if (!s.supportsNativeQuestions || s.departed || s.chat!==here() || s.manual || s.log.fault ||
              s.log.historyChangedAt!=null || !nativeQuestionId || !pending?.dispatched || pending.expired ||
              pending.answerJob || !ArenaBridge.sameQuestion(pending.wire,answer) ||
              !pending.wire.options.includes(answer.answer) || composer.issue || composer.verification || composer.value || composer.upload)
            throw Error('Cannot deliver the answer to the original active Arena question.');
          pending.answerJob=job.id; pending.answer=answer.answer; pending.clickedAt=Date.now();
          try {
            if (pending.sources) page.selectImageChoice(answer,pending.sources);
            else page.selectNativeAnswer(answer);
          }
          catch (error) { suspend(s,{kind:'blocked',text:error.message},job.id); return; }
          collect(s);
          return;
        }
        if (s.question) throw Error('An Arena question is waiting for an explicit selection.');
        if (!ready || s.manual || !guard(s, count)) throw Error('Browser received another turn before submission.');
        const outgoing = ArenaBridge.delivery(job.text, job.id);
        await page.submit({...job,...outgoing}, '', verifySource => guard(s,count,verifySource),
          () => {
            s.passiveFollowupIndex=null;s.log.expect(job.id, job.text, null, outgoing.receipt);
          }, null, true, () => session===s && !prepared && !s.departed && s.chat===here() && s.problem?.transcriptChanged);
      } catch (error) {
        if (s.problem || error.kind || 'nativeAnswer' in job) suspend(s, s.problem || {kind:error.kind||'blocked',text:error.message},job.id);
        else if (s.log.expected) s.outbox.push(...s.log.fail(error.message));
        else s.outbox.push(ArenaBridge.event('blocked', { job: job.id, text: error.message }));
      } finally { s.sending = false; }
      collect(s);
    } catch (error) {
      status = 'Bridge paused: ' + error.message;
    } finally { processing = false; }
  }

  async function control(message) {
    if (message.type === 'status') {
      if (!session || message.pageKey !== pageKey) throw Error('Document reloaded. Reconnect from the extension.');
      return { status };
    }
    if (!here() || message.chat !== here()) throw Error('The tab is no longer showing the selected chat.');
    if (message.type === 'prepare') {
      if (skill || session?.sending || session?.manual || session?.publishingReply)
        throw Error('A browser send or reply confirmation is in progress. Inspect the chat after it finishes.');
      if (page.state().verification) throw Error('Complete Arena Security Verification in Chrome before pairing.');
      let rows = page.rows();
      const last=rows.at(-1);
      if (last?.multipleFinalBodies) {
        const {siteId,text,toolFrame}=last, count=rows.length;
        if (!last.complete || !text || page.state().generating)
          throw Error('Wait for the visible answer sections to finish before binding.');
        await new Promise(resolve=>setTimeout(resolve,finalSettleMs));
        rows=page.rows();
        const current=rows.at(-1);
        if (message.chat!==here() || rows.length!==count || !current?.multipleFinalBodies || !current.complete ||
            current.siteId!==siteId || current.text!==text || current.toolFrame!==toolFrame)
          throw Error('The visible answer sections changed during pairing. Wait for the answer to settle.');
      }
      const state = page.state();
      if (state.verification) throw Error('Complete Arena Security Verification in Chrome before pairing.');
      if (state.issue && !state.issue.account) throw Error(state.issue.text);
      const priorDelivery = session && (session.problem || session.log.fault || session.log.expected || session.outbox.length);
      const recover = priorDelivery && session.chat === here() && state.idle && rows.at(-1)?.role === 'user';
      if (!rows.length || rows.some(row => !['user','assistant'].includes(row.role)) || !recover && rows.at(-1).role !== 'assistant')
        throw Error('Wait for a recognizable completed conversation before binding.');
      if (state.generating || !recover && !rows.at(-1).complete || !(rows.at(-1).text || rows.at(-1).artifact))
        throw Error('Arena has not confirmed the previous response is finished.');
      prepared = { chat: message.chat, log: new ArenaBridge.Transcript(rows), expires:Date.now()+15000 };
      return { chat: message.chat, pageKey, settledDelivery:ArenaBridge.pairingSettlement(rows) };
    }
    if (message.pageKey !== pageKey) throw Error('The Arena document changed during pairing.');
    if (message.type === 'attach' && prepared?.chat === message.chat) {
      // Keep pending observations and the history cursor on an idempotent bind.
      if (!session || message.reset || session.binding !== message.binding || session.log.fault || session.departed)
        session = { ...prepared, binding: message.binding, outbox: [] };
      updateContext(session,message.context);
      prepared = null;
      status = 'Connected.';
      return {};
    }
    const s = session;
    if (!s || s.binding !== message.binding || s.departed || s.chat !== here()) throw Error('This document is not paired.');
    if (message.type === 'verifyDocument') return {chat:s.chat, pageKey, binding:s.binding};
    if (message.type === 'releaseSkill') { skill = null; return {}; }
    if (message.type === 'holdSkill') {
      collect(s);
      const state = page.state();
      if (processing || skill || !state.idle || !state.value?.trim() || s.log.expected
          || s.log.waiting || s.log.pendingRows || s.log.fault || s.outbox.length)
        throw Error('Write a draft in the idle Arena composer before selecting a skill.');
      skill = { draft: state.value, count: s.log.seen.length, retained:state.upload ? page.browserAttachment(state) : null, expires: Date.now() + 15000 };
      return {};
    }
    if (message.type !== 'applySkill' || !skill) throw Error('Unknown document action.');
    const text = skill.draft + '\n\nLocal skill (' + message.name + ')\n' + message.content;
    skill.applying = true;
    try {
      await submitBrowser(s, skill.draft, text, skill.count,skill.retained);
    } catch (error) {
      if (error.kind) suspend(s, {kind:error.kind, text:error.message});
      throw error;
    } finally { skill.applying = false; }
    collect(s);
    return {};
  }

  function updateContext(s, context) {
    s.context = context?.id && typeof context.text === 'string' && context.text && context.id !== s.appliedContext ? context : null;
  }

  async function submitBrowser(s, draft, text, count, retained) {
    const context = s.context;
    const full = context ? context.text + '\n\n' + text : text;
    const outgoing = ArenaBridge.delivery(full);
    await page.submit(outgoing, draft, verifySource => guard(s,count,verifySource),
      () => s.log.expect(null, full, context?.id, outgoing.receipt, draft), retained);
    collect(s);
  }

  function intercept(event) {
    const s = session;
    if (!event.isTrusted || !s || s.chat !== here() || s.departed) return;
    const state = page.state();
    if (event.type === 'keydown') {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
          || (!state.field?.contains(event.target) && state.field !== event.target)) return;
    } else if (event.button !== 0 || (!state.button?.contains(event.target) && state.button !== event.target)) return;
    let retained;
    const bridgeBusy = s.sending || s.manual || skill || s.log.expected || s.publishingReply;
    if (state.upload && !bridgeBusy) {
      if (!state.value?.trim()) return;
      try {
        retained = page.browserAttachment(state);
        if (!retained?.()) return;
      }
      catch { return; } // Unsupported native attachments stay entirely with Arena.
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (bridgeBusy || event.repeat) return;
    collect(s);
    if (!state.idle || !state.value?.trim() || s.log.fault || s.log.waiting || s.log.pendingRows) {
      changed(s, s.log.fault || 'Browser draft kept. Wait for an idle composer to send this turn.');
      return;
    }
    s.manual = true;
    Promise.resolve().then(() => submitBrowser(s,state.value,state.value,s.log.seen.length,retained)).catch(error => {
      suspend(s,{kind:error.kind || 'blocked',text:error.message});
    }).finally(() => { s.manual = false; });
  }

  addEventListener('keydown',intercept,true);
  addEventListener('click',intercept,true);
  addEventListener('pagehide',event => { if (event.isTrusted && session) session.departed = true; });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    control(message).then(result => respond({ ...result, ok: true }), error => respond({ ok:false, error:error.message }));
    return true;
  });
  new MutationObserver(() => {
    if (session && !session.log.fault) collect(session);
  }).observe(document.documentElement, { childList:true, characterData:true, attributes:true, subtree:true,
    attributeFilter:['aria-label','aria-busy','data-streaming','data-message-status','data-status'] });
  setInterval(tick, 700);
})();
