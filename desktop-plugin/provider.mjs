import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { fileMetadata, selectedFileRefs, stageFiles } from './original-files.mjs'
import { outgoingPng } from './outgoing-image.mjs'
import { audioTrackLabels, choiceAudioLabels, incomingAudioLinks, matchesIncomingAudioLinks } from './incoming-audio.mjs'
import { batchName, batchTools, hasHelpHint, programToolRoutes } from './tool-help.mjs'

export const route = 'arena'
const model = { provider: route, id: 'agent-mode', name: 'Arena Agent Mode', inputModalities: ['text', 'image'] }
const noRetries = { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }
const generatedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const maxGeneratedBytes = 8 * 1024 ** 2
const maxGeneratedImages = 20
const maxOutgoingImages = 20 // Default DSH LocalAttachments limit per native message.
const maxOutgoingBytes = 32 * 1024 ** 2
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isBatch = items => Array.isArray(items) && items.length >= 2
const voiceProgramDescription = 'Choose a voice from Arena'
const audioQuestionProgramDescription = 'Choose an option for Arena audio'
const questionProgram = 'await tools.ask_user_question('
const unavailableAudio = 'Desktop could not save the Arena audio. You can open it in the original Arena tab.'

const galleryArguments = z.object({questions:z.tuple([z.object({
  id:z.string().min(1), question:z.string().min(1), options:z.array(z.object({label:z.string().min(1)}).strict()).min(1),
}).strict()])}).strict()
const galleryProof = z.object({arguments:galleryArguments,text:z.string()}).strict()

function isGalleryReply(message) {
  if (message.content.some(block => block.type === 'image')) return true
  const calls = message.content.filter(block => block.type === 'tool-call')
  if (calls.length !== 1 || !['run_code','ask_user_question'].includes(calls[0].name)) return false
  const call = calls[0]
  try {
    let args = JSON.parse(call.arguments)
    let description
    if (call.name === 'run_code') {
      if (!record(args) || Object.keys(args).length !== 2 ||
          ![voiceProgramDescription,audioQuestionProgramDescription].includes(args.description) ||
          typeof args.code !== 'string' || !args.code.startsWith(questionProgram) || !args.code.endsWith(')')) return false
      description = args.description
      const json = args.code.slice(questionProgram.length,-1)
      args = JSON.parse(json)
      if (JSON.stringify(args) !== json) return false
    }
    const parsed = galleryArguments.safeParse(args)
    if (!parsed.success) return false
    const options = parsed.data.questions[0].options.map(option=>option.label)
    const voices = options.at(-1) === 'Skip' ? options.slice(0,-1) : options
    const voiceOptions = voices.length > 0 && choiceAudioLabels(voices).every((label,index)=>label === voices[index])
    return message.content.some(block => {
      if (block.type !== 'text') return false
      if (description !== audioQuestionProgramDescription && voiceOptions && matchesIncomingAudioLinks(block.text,call.id,voices))
        return true
      return description !== voiceProgramDescription &&
        matchesIncomingAudioLinks(block.text,call.id,audioTrackLabels(block.text.split('\n').length))
    })
  } catch { return false }
}

// The bounded, host-only projection is rebuilt from the Desktop session on
// restore. The executor records the settled nested dispatch before the outer
// result. Neither runtime stdout nor an unrelated call can supply the answer.
const galleryProjection = {
  key:'arenaGalleryAnswer', stateVersion:1,
  stateSchema:z.object({callId:z.string(),settled:z.boolean(),proof:galleryProof.nullable()}).strict().nullable(),
  init:()=>null,
  apply(state,event) {
    if (event.type === 'assistant/message') {
      const message = event.data.message
      if (message.source?.provider !== route || message.source.model !== model.id ||
          !isGalleryReply(message)) return null
      const calls = message.content.filter(block=>block.type === 'tool-call')
      return calls.length === 1 && calls[0].name === 'run_code' ? {callId:calls[0].id,settled:false,proof:null} : null
    }
    if (!state || event.type !== 'tool/ptc-dispatch') return state
    const {parentCallId,rootCallId,name,arguments:args,content,isError} = event.data
    if (parentCallId !== state.callId || rootCallId !== state.callId || name !== 'ask_user_question') return state
    const parsed = !state.settled && isError === false && content?.length === 1 && content[0].type === 'text' &&
      galleryProof.safeParse({arguments:args,text:content[0].text})
    return {callId:state.callId,settled:true,proof:parsed?.success ? parsed.data : null}
  },
}

async function storeGeneratedImages(ctx, images, signal) {
  if (!Array.isArray(images) || images.length < 1 || images.length > maxGeneratedImages)
    throw Error(`Expected one to ${maxGeneratedImages} generated Arena images`)
  let total = 0
  const parts = images.map(image => {
    if (!generatedImageTypes.has(image?.mediaType) || typeof image.data !== 'string' || !image.data.length) {
      throw Error('Expected encoded PNG, JPEG or WebP image data from Arena')
    }
    total += Buffer.byteLength(image.data, 'base64')
    if (total > maxGeneratedBytes) throw Error('Generated Arena images exceed the 8 MiB reply limit')
    return { type:'image', mediaType:image.mediaType, data:image.data }
  })
  const store = ctx.get('attachments')
  if (!store) throw Error('DSH attachment service unavailable')
  signal?.throwIfAborted()
  // Native batch admission checks canonical base64, decodes each raster and
  // returns durable references only after the complete batch is available.
  const blocks = await store.admitPromptContent(parts)
  signal?.throwIfAborted()
  return blocks
}

function isTurn(message) {
  return message.role === 'assistant' || message.role === 'tool' ||
    (message.role === 'user' && ['user', 'goal'].includes(message.source?.kind))
}

function requestIdFor(sessionId, messageId) {
  return createHash('sha256').update(JSON.stringify([sessionId, messageId])).digest('hex')
}

function imageReadCaption(ref, png) {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const name = typeof ref.name === 'string' ? win32.basename(ref.name).replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() : ''
  const filename = [...name].slice(0,120).join('')
  const caption = `${filename || 'Image'} (${width}×${height} px`
  const origin = ref.originalDimensions ?? ref
  if (![origin.width,origin.height].every(value => Number.isSafeInteger(value) && value > 0) ||
      (origin.width === width && origin.height === height)) return caption + ')'
  const x = Number((origin.width / width).toFixed(4))
  const y = Number((origin.height / height).toFixed(4))
  const scale = x === y ? `×${x}` : `×${x} x / ×${y} y`
  return `${caption}, original ${origin.width}×${origin.height} px, coordinates ${scale})`
}

function readBatchResults(calls, results, callPrefix) {
  if (!isBatch(calls) || calls.length !== results.length ||
      !calls.every((call, index) => call.id === `${callPrefix}_${index}` && batchTools.has(call.name))) {
    throw Error('Arena cannot match this read batch to its original calls')
  }
  const byId = new Map(results.filter(result => result.role === 'tool').map(result => [result.toolCallId, result]))
  return calls.map(call => {
    const result = byId.get(call.id)
    if (!result?.id || !result.content.every(block => block.type === 'text')) {
      throw Error('Arena requires one text result for each tool in the read batch')
    }
    return { toolCallId: call.id, failed: result.isError === true, text: result.content.map(block => block.text).join('\n') }
  })
}

function selectMessage(messages, sessionId) {
  // DSH also injects user-role notices, skill catalogs and runtime context.
  // Only human actions, native goal rounds and our own tool results start a delivery.
  const index = messages.findLastIndex(isTurn)
  const message = messages[index]
  if (!message?.id || message.role === 'assistant') throw Error('Arena requires a new user message, goal round or native tool result')
  if (message.role === 'tool') {
    const assistantAt = messages.slice(0, index).findLastIndex(previous => previous.role === 'assistant')
    const assistant = messages[assistantAt]
    const origin = messages.slice(0, assistantAt).findLast(isTurn)
    const mismatch = () => Error('Arena cannot match this tool result to its original request and Desktop session')
    if (assistant?.source?.provider !== route || assistant.source.model !== model.id || !origin?.id || origin.role === 'assistant') {
      throw mismatch()
    }
    const callPrefix = 'arena_' + requestIdFor(sessionId, origin.id)
    const calls = assistant.content.filter(block => block.type === 'tool-call')
    if (calls.length > 1) {
      const results = readBatchResults(calls, messages.slice(assistantAt + 1, index + 1).filter(isTurn), callPrefix)
      return { message, index, results }
    }
    if (message.toolCallId !== callPrefix || calls[0]?.id !== message.toolCallId) {
      throw mismatch()
    }
    const toolName = calls[0].name
    const gallery = isGalleryReply(assistant)
    return { message, index, toolName, gallery }
  }
  return { message, index }
}

export class ArenaAdapter extends LlmAdapter {
  constructor(ctx, companion, pollMs = 350) {
    super()
    this.ctx = ctx
    this.companion = companion
    this.pollMs = pollMs
    this.shellResults = new Map()
    this.toolSteps = new WeakMap()
    this.galleryProjection = ctx.sessionProjections?.register?.(galleryProjection)
    // The model request carries the turn signal and outer schemas. The loop
    // supplies the step's live, revocable tool set when it assembles that request.
    ctx.on?.('system-prompt/assemble', async (assembly, {scope,agent,signal,toolSet,modelSelection}, next) => {
      // Harness restores a registered complete prompt after all listeners return.
      const complete = assembly.sections.some(section=>section.complete === true)
      const presentation = await next()
      if (scope === agent && agent && signal && toolSet &&
          modelSelection?.provider === route && modelSelection.model === model.id) {
        // Only retain the two executor sections used to identify the program route.
        const sections = complete ? [] : presentation.sections.filter(section=>section.name==='tools:sdk' || section.name==='tools:ptc-only')
        this.toolSteps.set(signal,{agent,toolSet,sections})
      }
      return presentation
    })
  }

  toolStep(options) {
    const step = this.toolSteps.get(options.signal)
    if (step && !options.signal.aborted && step.agent.session.id === options.sessionId) return step
  }

  questionAdmission(options) {
    const step = this.toolStep(options)
    if (step) return step.toolSet.view(step.agent).has('ask_user_question')
  }

  admitsGalleryProgram(options) {
    return this.questionAdmission(options) === true && this.ctx.get?.('ptcRuntime')?.language === 'typescript'
  }

  recordShellResult(exec, result) {
    const sessionId = exec.agent?.session?.id
    const value = result.value
    if (!sessionId || exec.name !== 'pwsh' || !/^arena_[a-f0-9]{64}$/.test(exec.callId) ||
        result.isError || value?.kind !== 'foreground') return
    const { exitCode, signal, timedOut } = value
    if (!(exitCode === null || Number.isSafeInteger(exitCode)) ||
        !(signal === null || typeof signal === 'string') || typeof timedOut !== 'boolean') return
    const key = JSON.stringify([sessionId,exec.callId])
    this.shellResults.set(key,{exitCode,signal,timedOut})
    if (this.shellResults.size > 64) this.shellResults.delete(this.shellResults.keys().next().value)
  }

  providerInfo() { return { id: route, name: 'Arena' } }
  async listModels() { return [model] }
  async resolveModel(provider, id) {
    if (provider !== route || id !== model.id) throw Error('Select Arena Agent Mode')
    return model
  }
  providerRetryPolicy() { return noRetries }

  async request(options) {
    if (options.purpose) throw Error('Arena does not accept auxiliary model requests')
    if (!options.sessionId) throw Error('Arena requires a Desktop session')
    const { message, index, results, toolName, gallery } = selectMessage(options.messages, options.sessionId)
    const requestId = requestIdFor(options.sessionId, message.id)
    const tools = (options.tools ?? []).filter(tool => tool.name !== batchName)
    const catalog = tools.some(tool => tool.name === 'skill')
      ? options.messages.findLast(row => row.role === 'user' && row.source?.kind === 'skill-catalog' && row.source.form === 'catalog')
      : undefined
    const skills = (catalog?.source.entries ?? []).map(({ name, description }) => ({ name, description }))
    const request = { requestId, sessionId: options.sessionId, text: '', tools, skills }
    if (tools.some(tool => tool.name === 'arena_tool_help')) request.toolHelpDirect = hasHelpHint(options.messages)
    if (tools.some(tool => tool.name === 'run_code') && this.admitsGalleryProgram(options)) request.galleryViaCode = true
    const step = this.toolStep(options)
    if (step && tools.some(tool => tool.name === 'run_code')) {
      const program = programToolRoutes(this.ctx,step.agent,step.toolSet,tools,step.sections)
      if (program) request.programToolRoutes = program
      if (program?.names.includes('arena_tool_help') && hasHelpHint(options.messages)) {
        request.toolHelpProgram = program.language
        request.toolHelpViaCode = true
      }
    }
    if (tools.some(tool => batchTools.has(tool.name))) request.supportsReadBatch = true
    // The Desktop preset owns Plan Mode. Read the same committed session projection
    // as Desktop, so a pending selection takes effect at the next step boundary.
    const agent = this.ctx.agents?.get(options.sessionId)
    const planMode = agent && this.ctx.sessionProjections?.snapshot(agent.session, ['plan']).values.plan?.active
    if (typeof planMode === 'boolean') request.planMode = planMode
    if (results) {
      request.toolResult = JSON.stringify({ results })
      request.toolResultView = {}
      return request
    }
    const parts = []
    const pngs = []
    let imageBytes = 0
    let imageCaption
    const selected = selectedFileRefs(this.ctx,agent,message)
    const imageCount = message.content.filter(block => block.type === 'image').length
    if (imageCount && message.role !== 'tool')
      throw Error('Desktop supplied a converted preview. Reattach the original file in the Arena composer.')
    if (imageCount > maxOutgoingImages) throw Error('Arena accepts up to 20 tool images per turn')
    for (const [i,block] of message.content.entries()) {
      if (selected.has(i)) (request.files ??= []).push(fileMetadata(selected.get(i)))
      else if (block.type === 'text') parts.push(block.text)
      else if (block.type === 'image') {
        const png = await outgoingPng(this.ctx, block, options.signal)
        imageBytes += png.length
        if (imageBytes > maxOutgoingBytes) throw Error('Arena images exceed the 32 MiB limit per turn')
        pngs.push(png.toString('base64'))
        if (toolName === 'read_image' && !message.isError) imageCaption = imageReadCaption(block.attachment,png)
      } else throw Error('Unexpected Desktop content block. Reattach the original file in the Arena composer.')
    }
    if (pngs.length === 1) request.png = pngs[0]
    else if (pngs.length > 1) request.pngs = pngs
    if (message.role === 'tool') {
      const galleryProgram = gallery && toolName === 'run_code'
      if (gallery && (galleryProgram ? !request.galleryViaCode : !tools.some(tool=>tool.name === 'ask_user_question')))
        throw Error('The Desktop gallery permission changed. If the panel is still open in the original Arena tab, choose an option there.')
      if (galleryProgram && agent) {
        const settled = (await this.galleryProjection)?.stateOf(agent.session)
        if (settled?.callId === message.toolCallId && settled.proof)
          request.galleryAnswer = {callId:settled.callId,...settled.proof}
      }
      const text = galleryProgram ? '' : parts.join('\n')
      request.toolResult = JSON.stringify({ toolCallId: message.toolCallId, failed: message.isError === true, text })
      request.toolResultView = {}
      if (imageCaption && pngs.length === 1) request.toolResultView.image = imageCaption
      if (toolName === 'pwsh' && !message.isError) {
        const key = JSON.stringify([options.sessionId,message.toolCallId])
        const process = this.shellResults.get(key)
        if (process) request.toolResultView.process = process
      }
    } else {
      for (const extra of options.messages.slice(index + 1)) {
        if (extra.role === 'user' && extra.source?.kind === 'skill-invocation') {
          for (const block of extra.content) if (block.type === 'text') parts.push(block.text)
        }
      }
      request.text = parts.join('\n')
    }
    return request
  }

  async *stream(options) {
    await this.resolveModel(options.provider, options.model)
    const { signal } = options
    signal?.throwIfAborted()
    const request = await this.request(options)
    const address = { id: request.requestId, sessionId: request.sessionId }
    let reply
    let playbackNotice = false
    signal?.throwIfAborted()
    // Older companions expand every delivery with native schemas and Computer Use instructions.
    const setup = await this.companion.rpc('setup')
    if (setup?.supportsOnDemandContext !== true)
      throw Error('Update the Arena bridge companion to use on-demand tool documentation')
    if (request.files && setup.supportsFiles !== true) throw Error('Update the Arena bridge companion to send original files.')
    if (request.pngs && setup.supportsPngBatch !== true) throw Error('Update the Arena bridge companion to send multiple images in one turn')
    if (setup.supportsResultView !== true) delete request.toolResultView
    signal?.throwIfAborted()
    try {
      if (request.files) {
        try {
          await stageFiles(this.companion,this.ctx.get('attachments'),request,signal)
          signal?.throwIfAborted()
        } catch (error) {
          if (!signal?.aborted) await this.companion.rpc('cancel',address).catch(()=>{})
          throw error
        }
      }
      if (this.questionAdmission(options) === false) {
        delete request.galleryViaCode
        request.tools = request.tools.filter(tool=>tool.name !== 'ask_user_question')
      }
      const ack = await this.companion.rpc('start', request)
      if (ack.id !== address.id) throw Error('Arena bridge returned a different request ID')
      for (;;) {
        signal?.throwIfAborted()
        const status = await this.companion.rpc('status', address)
        if (status.state === 'done') { reply = status.reply; break }
        if (!['queued', 'waiting'].includes(status.state)) throw Error(status.error || `Arena request ${status.state}`)
        if (status.voicePlaybackRequired === true && !playbackNotice) {
          playbackNotice = true
          const block = {type:'text',text:'Play the chosen voice sample in the original Arena tab. Desktop will apply your choice when Arena enables it.'}
          yield {type:'block-start',index:0,blockType:'text'}
          yield {type:'text-delta',index:0,text:block.text}
          yield {type:'block-end',index:0,block}
        }
        await delay(this.pollMs, undefined, { signal })
      }
      signal?.throwIfAborted()
    } catch (error) {
      if (signal?.aborted) await this.companion.rpc('cancel', address).catch(() => {})
      throw error
    }
    const blocks = []
    const imageChoice = reply?.kind === 'image-choice' && reply.name === 'ask_user_question'
    const audioChoice = reply?.kind === 'audio-choice' && reply.name === 'ask_user_question'
    const audioQuestion = reply?.kind === 'audio-question' && reply.name === 'ask_user_question'
    const hasAudio = audioChoice || audioQuestion
    const gallery = imageChoice || hasAudio
    const renderAudio = async labels => {
      try {
        return await incomingAudioLinks(setup.audioDirectory, reply.audio, address.id, labels, signal)
      } catch {
        signal?.throwIfAborted()
        return undefined
      }
    }
    if (reply?.kind === 'text' && typeof reply.text === 'string') {
      const labels = audioTrackLabels(Array.isArray(reply.audio) ? reply.audio.length : 0)
      const audio = reply.audio === undefined ? '' : await renderAudio(labels) ?? unavailableAudio
      const text = [reply.text,audio].filter(Boolean).join('\n\n')
      if (text || reply.images === undefined) blocks.push({ type:'text', text })
      if (reply.images !== undefined) blocks.push(...await storeGeneratedImages(this.ctx, reply.images, signal))
    } else if (reply?.kind === 'tool-batch') {
      const { calls, text, images } = reply
      if (!request.supportsReadBatch || !isBatch(calls) || images !== undefined || reply.audio !== undefined ||
          (text !== undefined && typeof text !== 'string') || !calls.every(call => record(call) &&
            Object.keys(call).length === 2 && batchTools.has(call.name) && record(call.arguments) &&
            request.tools.some(tool => tool.name === call.name))) {
        throw Error('Invalid Arena read batch or tool outside the active DSH profile')
      }
      if (text) blocks.push({ type:'text', text })
      calls.forEach((call, index) => blocks.push({ type:'tool-call', id:`arena_${address.id}_${index}`,
        name:call.name, arguments:JSON.stringify(call.arguments) }))
    } else if ((reply?.kind === 'tool' || gallery) && reply.images === undefined && (hasAudio || reply.audio === undefined) &&
             (gallery || request.tools.some(tool => tool.name === reply.name)) &&
             reply.arguments && typeof reply.arguments === 'object' && !Array.isArray(reply.arguments) &&
             (reply.text === undefined || typeof reply.text === 'string')) {
      let name = reply.name
      let args = reply.arguments
      if (reply.text) blocks.push({ type:'text', text:reply.text })
      if (gallery) {
        const parsed = galleryArguments.safeParse(args)
        if (!parsed.success) throw Error('Invalid Arena question and options')
        const [question] = parsed.data.questions
        const choices = question.options
        const labels = audioQuestion ? audioTrackLabels(Array.isArray(reply.audio) ? reply.audio.length : 0)
          : audioChoice ? choiceAudioLabels(reply.audio)
          : Array.isArray(reply.previews) ? reply.previews.map((_,index) => `Image ${index+1}`) : []
        if (!labels.length || !audioQuestion && (!labels.every((label,index) => choices[index]?.label === label) ||
            (choices.length !== labels.length && !(choices.length === labels.length+1 && choices.at(-1)?.label === 'Skip'))))
          throw Error(`Arena ${audioChoice ? 'voice' : 'image'} choices and previews do not match`)
        if (hasAudio) {
          const links = await renderAudio(labels)
          blocks.push({type:'text',text:links ?? unavailableAudio})
          if (!links) name = undefined
        } else {
          const previews = await storeGeneratedImages(this.ctx, reply.previews, signal)
          previews.forEach((image,index) => blocks.push({type:'text',text:labels[index]}, image))
        }
        if (name && (!request.tools.some(tool => tool.name === name) || this.questionAdmission(options) === false)) {
          if (request.galleryViaCode && this.admitsGalleryProgram(options)) {
            const payload = {questions:[{id:question.id,question:question.question,options:choices.map(({label})=>({label}))}]}
            name = 'run_code'
            args = {description:audioQuestion ? audioQuestionProgramDescription :
                audioChoice ? voiceProgramDescription : 'Choose an image from the Arena gallery',
              code:`${questionProgram}${JSON.stringify(payload)})`}
          } else {
            name = undefined
            blocks.push({type:'text',text:'If the panel is still open in the original Arena tab, choose an option there.'})
          }
        }
      }
      if (name) blocks.push({ type:'tool-call', id:'arena_' + address.id, name, arguments:JSON.stringify(args) })
    } else throw Error('Invalid reply or tool outside the active DSH profile')
    for (const [offset, block] of blocks.entries()) {
      const index = offset + Number(playbackNotice)
      signal?.throwIfAborted()
      yield { type:'block-start', index, blockType:block.type }
      if (block.type === 'text') yield { type:'text-delta', index, text:block.text }
      if (block.type === 'tool-call') yield { type:'tool-call-delta', index, id:block.id, name:block.name, argumentsDelta:block.arguments }
      yield { type:'block-end', index, block }
    }
    yield { type:'finish', reason:{ kind:blocks.some(block=>block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
  }
}
