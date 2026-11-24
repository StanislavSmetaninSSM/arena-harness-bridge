import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { outgoingPng } from './outgoing-image.mjs'
import { committedSection, hasHelpHint } from './tool-help.mjs'

export const route = 'arena'
const model = { provider: route, id: 'agent-mode', name: 'Arena Agent Mode', inputModalities: ['text', 'image'] }
const noRetries = { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }
const generatedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const maxGeneratedBytes = 8 * 1024 ** 2
const maxGeneratedImages = 20
const maxOutgoingImages = 20 // Default DSH LocalAttachments limit per native message.
const maxOutgoingBytes = 32 * 1024 ** 2
const batchName = 'arena_read_batch'
const batchTools = new Set(['read', 'glob', 'grep'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isBatch = items => Array.isArray(items) && items.length >= 2
const cuaSectionName = 'computer-use:dsh-cua'
const cuaToolNames = new Set(['cua', 'cua_run_code', 'run_code'])

// rc.5 commits a single flattened system message. Obtain the named section
// from the same Agent's native assembly and require it in that committed text.
async function legacyCuaGuidance(ctx, agent, options, message) {
  if (!agent || message.content?.length !== 1 || message.content[0]?.type !== 'text') return ''
  // PTC can wrap either scoped CUA tool behind the single run_code schema.
  if (!options.tools?.some(tool => tool.name === 'cua' || tool.name === 'cua_run_code') &&
      !ctx.tools?.get('cua',agent) && !ctx.tools?.get('cua_run_code',agent)) return ''
  const service = ctx.get?.('systemPrompt')
  if (!service) return ''
  const assembly = await service.assemble({agent, scope:agent, signal:options.signal,
    modelSelection:{provider:options.provider,model:options.model}})
  const sections = assembly.sections.filter(section => section.name === cuaSectionName)
  if (sections.length !== 1) return ''
  const guide = sections[0].text
  if (typeof guide !== 'string' || !guide.trim()) return ''
  return ('\n\n' + message.content[0].text + '\n\n').includes('\n\n' + guide + '\n\n') ? guide : ''
}

async function computerUseGuidance(ctx, agent, options) {
  const section = committedSection(options.messages, cuaSectionName)
  return section?.legacy ? legacyCuaGuidance(ctx,agent,options,section.legacy) : section?.text ?? ''
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
    return { message, index, toolName:calls[0].name }
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
    const { message, index, results, toolName } = selectMessage(options.messages, options.sessionId)
    const requestId = requestIdFor(options.sessionId, message.id)
    const tools = (options.tools ?? []).filter(tool => tool.name !== batchName)
    const catalog = tools.some(tool => tool.name === 'skill')
      ? options.messages.findLast(row => row.role === 'user' && row.source?.kind === 'skill-catalog' && row.source.form === 'catalog')
      : undefined
    const skills = (catalog?.source.entries ?? []).map(({ name, description }) => ({ name, description }))
    const request = { requestId, sessionId: options.sessionId, text: '', tools, skills }
    if (tools.some(tool => tool.name === 'run_code') && hasHelpHint(options.messages)) request.toolHelpViaCode = true
    if (tools.some(tool => batchTools.has(tool.name))) request.supportsReadBatch = true
    // The Desktop preset owns Plan Mode. Read the same committed session projection
    // as Desktop, so a pending selection takes effect at the next step boundary.
    const agent = this.ctx.agents?.get(options.sessionId)
    request.computerUseGuidance = tools.some(tool => cuaToolNames.has(tool.name))
      ? await computerUseGuidance(this.ctx, agent, options) : ''
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
    if (message.content.filter(block => block.type === 'image').length > maxOutgoingImages) throw Error('Arena accepts up to 20 images per turn')
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
      else if (block.type === 'image') {
        const png = await outgoingPng(this.ctx, block, options.signal)
        imageBytes += png.length
        if (imageBytes > maxOutgoingBytes) throw Error('Arena images exceed the 32 MiB limit per turn')
        pngs.push(png.toString('base64'))
        if (toolName === 'read_image' && !message.isError) imageCaption = imageReadCaption(block.attachment,png)
      } else throw Error('Arena supports text and static image attachments in a message')
    }
    if (pngs.length === 1) request.png = pngs[0]
    else if (pngs.length > 1) request.pngs = pngs
    if (message.role === 'tool') {
      request.toolResult = JSON.stringify({ toolCallId: message.toolCallId, failed: message.isError === true, text: parts.join('\n') })
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
    signal?.throwIfAborted()
    const needsGuidanceSupport = request.tools.some(tool => cuaToolNames.has(tool.name))
    if (request.pngs || request.toolResultView || needsGuidanceSupport) {
      const setup = await this.companion.rpc('setup')
      if (request.toolHelpViaCode && setup?.supportsToolHelp !== true)
        throw Error('Update the Arena bridge companion to deliver the Harness tool reference')
      if (needsGuidanceSupport && setup?.supportsComputerUseGuidance !== true)
        throw Error('Update the Arena bridge companion to deliver native Computer Use instructions')
      if (request.pngs && setup?.supportsPngBatch !== true) throw Error('Update the Arena bridge companion to send multiple images in one turn')
      if (setup?.supportsResultView !== true) delete request.toolResultView
      signal?.throwIfAborted()
    }
    try {
      const ack = await this.companion.rpc('start', request)
      if (ack.id !== address.id) throw Error('Arena bridge returned a different request ID')
      for (;;) {
        signal?.throwIfAborted()
        const status = await this.companion.rpc('status', address)
        if (status.state === 'done') { reply = status.reply; break }
        if (!['queued', 'waiting'].includes(status.state)) throw Error(status.error || `Arena request ${status.state}`)
        await delay(this.pollMs, undefined, { signal })
      }
      signal?.throwIfAborted()
    } catch (error) {
      if (signal?.aborted) await this.companion.rpc('cancel', address).catch(() => {})
      throw error
    }
    const blocks = []
    const imageChoice = reply?.kind === 'image-choice' && reply.name === 'ask_user_question'
    if (reply?.kind === 'text' && typeof reply.text === 'string') {
      if (reply.text || reply.images === undefined) blocks.push({ type:'text', text:reply.text })
      if (reply.images !== undefined) blocks.push(...await storeGeneratedImages(this.ctx, reply.images, signal))
    } else if (reply?.kind === 'tool-batch') {
      const { calls, text, images } = reply
      if (!request.supportsReadBatch || !isBatch(calls) || images !== undefined ||
          (text !== undefined && typeof text !== 'string') || !calls.every(call => record(call) &&
            Object.keys(call).length === 2 && batchTools.has(call.name) && record(call.arguments) &&
            request.tools.some(tool => tool.name === call.name))) {
        throw Error('Invalid Arena read batch or tool outside the active DSH profile')
      }
      if (text) blocks.push({ type:'text', text })
      calls.forEach((call, index) => blocks.push({ type:'tool-call', id:`arena_${address.id}_${index}`,
        name:call.name, arguments:JSON.stringify(call.arguments) }))
    } else if ((reply?.kind === 'tool' || imageChoice) && reply.images === undefined && request.tools.some(tool => tool.name === reply.name) &&
             reply.arguments && typeof reply.arguments === 'object' && !Array.isArray(reply.arguments) &&
             (reply.text === undefined || typeof reply.text === 'string')) {
      if (reply.text) blocks.push({ type:'text', text:reply.text })
      if (imageChoice) {
        const options = reply.arguments.questions?.[0]?.options
        const labels = Array.isArray(reply.previews) ? reply.previews.map((_,index) => `Image ${index+1}`) : []
        if (reply.arguments.questions?.length !== 1 || !Array.isArray(options) ||
            !labels.every((label,index) => options[index]?.label === label) ||
            (options.length !== labels.length && !(options.length === labels.length+1 && options.at(-1)?.label === 'Skip')))
          throw Error('Arena image choices and previews do not match')
        const previews = await storeGeneratedImages(this.ctx, reply.previews, signal)
        previews.forEach((image,index) => blocks.push({type:'text',text:labels[index]}, image))
      }
      blocks.push({ type:'tool-call', id:'arena_' + address.id, name:reply.name, arguments:JSON.stringify(reply.arguments) })
    } else throw Error('Invalid reply or tool outside the active DSH profile')
    for (const [index, block] of blocks.entries()) {
      signal?.throwIfAborted()
      yield { type:'block-start', index, blockType:block.type }
      if (block.type === 'text') yield { type:'text-delta', index, text:block.text }
      if (block.type === 'tool-call') yield { type:'tool-call-delta', index, id:block.id, name:block.name, argumentsDelta:block.arguments }
      yield { type:'block-end', index, block }
    }
    yield { type:'finish', reason:{ kind:reply.kind === 'text' ? 'stop' : 'tool-calls' } }
  }
}
