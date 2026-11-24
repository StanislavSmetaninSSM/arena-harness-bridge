import { createHash } from 'node:crypto'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'

const name = 'arena_tool_help'
const sectionName = 'arena:tool-help'
const marker = 'Arena tool reference is available for this step through arena_tool_help.'
const selection = {provider:'arena', model:'agent-mode'}
export const batchName = 'arena_read_batch'
export const batchTools = new Set(['read','glob','grep'])
const cuaTopic = 'computer-use:dsh-cua'
const cuaNames = ['cua','cua_run_code']
const imageTopic = 'bridge:images'
const literalScriptHelp = [
  'For a multiline Desktop call, set "command":{"$text":"script"} in its JSON arguments.',
  'In the same reply, put the literal command in one top-level fenced block opened by ```harness-text script and closed by ```.',
  'For a one-line command, use its normal JSON string.',
].join(' ')
const usage = 'List the current tools and guide topics with {}. Use name for tool documentation, guide for a listed topic, or sdk:true for the native run_code SDK. Repeat the same query with nextCursor as cursor for more.'
const parameters = {type:'object', additionalProperties:false, properties:{
  name:{type:'string',description:'Exact tool name from the current list.'},
  guide:{type:'string',description:'Published tool instruction ID from the current list.'},
  sdk:{type:'boolean',description:'Read the program SDK. Combine with name for one binding.'},
  cursor:{type:'string',description:'Continuation returned by the preceding page of the same query.'},
}}
const outputSchema = {type:'object', additionalProperties:false, required:['text','nextCursor'], properties:{
  text:{type:'string'}, nextCursor:{oneOf:[{type:'string'},{type:'null'}]},
}}

// alpha.2 journals named section updates. rc.5 commits one flat system
// message; callers must verify their own expected section in that message.
function committedSection(messages, sectionName) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (row.role !== 'system') continue
    if (row.source?.kind !== 'system-prompt') return
    const sections = row.source.sections
    if (sections === undefined) return {legacy:row}
    if (!Array.isArray(sections)) return
    const matches = sections.filter(section => section?.name === sectionName)
    if (matches.length) {
      const section = matches[0]
      const slot = section.contentIndex
      if (matches.length !== 1 || section.state !== 'active' || !Number.isInteger(slot) || slot < 0) return
      const ambiguous = sections.some(other =>
        (other !== section && other?.contentIndex === slot) ||
        (Array.isArray(other?.noticeIndex) && other.noticeIndex.includes(slot)))
      const block = row.content?.[slot]
      if (!ambiguous && block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return {text:block.text}
      }
      return
    }
    if (row.source.reset || row.source.complete) return
  }
}

export function hasHelpHint(messages) {
  const section = committedSection(messages, sectionName)
  if (!section?.legacy) return section?.text === marker
  const blocks = section.legacy.content
  return blocks?.length === 1 && blocks[0]?.type === 'text' &&
    typeof blocks[0].text === 'string' && blocks[0].text.split('\n\n').includes(marker)
}

function page(document, topic, cursor) {
  const chars = Array.from(document)
  const signature = createHash('sha256').update(JSON.stringify([topic,document])).digest('hex').slice(0,24)
  let start = 0
  if (cursor !== undefined) {
    const parts = typeof cursor === 'string' && /^([0-9a-f]{24}):([1-9]\d*)$/.exec(cursor)
    if (!parts || parts[1] !== signature || !Number.isSafeInteger(Number(parts[2])) || Number(parts[2]) >= chars.length)
      throw Error('This help page changed or the cursor belongs to another query. Repeat the query without cursor.')
    start = Number(parts[2])
  }
  const end = Math.min(start+3000, chars.length)
  return {text:chars.slice(start,end).join(''), nextCursor:end<chars.length ? signature+':'+end : null}
}

function currentSkills(agent) {
  const catalog = agent.session.deriveMessages().findLast(row => row.role === 'user' &&
    row.source?.kind === 'skill-catalog' && row.source.form === 'catalog')
  const entries = catalog?.source.entries
  return Array.isArray(entries) ? entries.filter(entry => typeof entry?.name === 'string' &&
    typeof entry.description === 'string') : []
}

function batchReference(members) {
  const member = {
    type:'object', additionalProperties:false, required:['name','arguments'],
    properties:{name:{enum:members},arguments:{type:'object'}},
  }
  return JSON.stringify({
    name:batchName,
    description:'Send two or more independent text inspections in one Desktop call. Use the native arguments for each tool. Results arrive in call order with individual IDs, status and output.',
    parameters:{type:'object', additionalProperties:false, required:['calls'],
      properties:{calls:{type:'array',minItems:2,items:member}}},
  },null,2)
}

// Harness publishes per-tool and shared tool:* instructions without a family
// membership field. Shared topics are discoverable by their own section IDs.
function reference(ctx, assembly, visible, agent, args, bindingSdk) {
  const runCode = assembly.tools.find(tool => tool.name === 'run_code')
  const active = assembly.sections.filter(section => !section.retire && !section.complete && section.text?.trim())
  const render = section => renderPrompt({...assembly, sections:[section]})
  const hasCua = cuaNames.some(toolName => visible.has(toolName))
  // The bridge's batch and literal script forms operate on direct wire calls.
  const direct = new Set(assembly.tools.map(tool => tool.name))
  const batchMembers = [...batchTools].filter(toolName => direct.has(toolName) && visible.has(toolName)).sort()
  const cua = hasCua && active.find(section => section.name === cuaTopic)
  const cuaHelp = () => cua ? render(cua) : 'Computer Use guidance is unavailable in this step. Wait for current guidance before using Computer Use.'
  // A scope mask also hides a registration from get(name, agent). Check its
  // declaring ancestors before treating the same ID as an independent guide.
  const scopes = [...scopeChainOf(agent), undefined]
  const guides = active.filter(section => {
    if (!section.name.startsWith('tool:')) return false
    const owner = section.name.slice(5)
    if (cuaNames.includes(owner)) return visible.has(owner)
    return visible.has(owner) || !scopes.some(scope => ctx.tools.get(owner, scope))
  })
  if (args.guide !== undefined) {
    if (args.guide === cuaTopic) return cuaHelp()
    if (args.guide === imageTopic) return "For image generation, use Arena's own image tool and include the image in your final answer for Desktop."
    const guide = guides.find(section => section.name === args.guide)
    return guide ? render(guide) : 'Tool guide unavailable. Request {} for published topics.'
  }

  const definition = visible.get(args.name)
  const sdk = runCode && active.find(section => section.name === 'tools:sdk')
  if (args.sdk && (args.name === undefined || args.name === 'run_code')) {
    return sdk ? render(sdk) : 'No program executor SDK is available in this step.'
  }
  if (args.name === undefined) {
    const names = new Set(visible.keys())
    if (!runCode) names.delete(batchName)
    if (batchMembers.length) names.add(batchName)
    if (runCode) names.add(runCode.name)
    const intro = runCode ? 'Inside run_code use await tools[name](args). Request {sdk:true} for the program SDK.'
      : 'Use the listed Harness tools directly.'
    const topics = [imageTopic,...guides.map(section => section.name)]
    if (cua) topics.push(cuaTopic)
    const lines = [intro, 'Tools (request with name):', ...[...names].sort(), '',
      'Published instructions (request with guide):', ...topics.sort()]
    if (visible.has('skill')) lines.push('', 'For available skills, request {name:"skill"}.')
    return lines.join('\n')
  }
  if (args.name === batchName && !runCode) {
    if (!batchMembers.length) return 'Tool unavailable in this step. Request the current list with {}.'
    return args.sdk ? 'The read batch is a direct Desktop call.' : batchReference(batchMembers)
  }
  const tool = definition ?? (args.name === runCode?.name ? runCode : undefined)
  if (!tool) return 'Tool unavailable in this step. Request the current list with {}.'
  const entry = {name:tool.name, description:tool.description, parameters:tool.parameters}
  const parts = []
  if (definition && sdk && bindingSdk) {
    // A presentation shortcut only. When the native renderer changes its
    // layout, the lossless per-binding SDK remains available in full.
    const outputMap = /^interface ToolOutputMap \{[\s\S]*?^\}/m.exec(bindingSdk)?.[0]
    if (args.sdk) return outputMap ? outputMap+'\n\n'+bindingSdk : bindingSdk
    if (outputMap) parts.push('Return value inside run_code:\n'+outputMap)
    else parts.push('Request {name, sdk:true} for this binding\'s native program types.')
  } else if (args.sdk) {
    return 'No program executor SDK is available in this step.'
  }
  if (definition) entry.canonicalOutput = definition.output.schema
  if (cuaNames.includes(args.name)) parts.push(cuaHelp())
  if (args.name === 'pwsh' && direct.has('pwsh')) parts.push(literalScriptHelp)
  if (args.name === 'skill') {
    const skills = currentSkills(agent)
    parts.push(skills.length ? ['Available skills:',...skills.map(entry => entry.name+' — '+entry.description)].join('\n') : 'No skills are listed in the current catalog.')
  }
  const guide = guides.find(section => section.name === 'tool:'+args.name)
  if (guide) parts.push(guide.name+'\n'+render(guide))
  parts.push(JSON.stringify(entry,null,2))
  return parts.join('\n\n')
}

// Let the scoped executor render the binding using its actual language, program
// format and return-value adaptation. Only narrow the real step's live view.
async function singleBindingSdk(ctx, context, toolName) {
  const toolSet = {...context.toolSet, view(scope) {
    const tool = context.toolSet.view(scope).get(toolName)
    return new Map(tool ? [[toolName,tool]] : [])
  }}
  const assembly = await ctx.systemPrompt.assemble({...context,toolSet})
  const section = assembly.sections.find(item => item.name === 'tools:sdk' && !item.retire && !item.complete && item.text?.trim())
  return section && renderPrompt({...assembly,sections:[section]})
}

export function registerToolHelp(ctx) {
  const help = {name, description:usage, parameters, output:{
    schema:outputSchema, render:(_args,value)=>[{type:'text',text:value.text+
      (value.nextCursor ? '\nNext page cursor: '+value.nextCursor : '')}],
  }, async execute(args, exec) {
    const {agent, toolSet, signal} = exec
    const admitted = agent && toolSet?.view(agent)
    if (admitted?.get(name) !== help)
      throw Error('Tool help requires an admitted Arena step.')
    if (!args || typeof args!=='object' || Array.isArray(args) ||
        Object.keys(args).some(key=>!Object.hasOwn(parameters.properties,key)) ||
        (args.name!==undefined && typeof args.name!=='string') ||
        (args.sdk!==undefined && typeof args.sdk!=='boolean') ||
        (args.guide!==undefined && (typeof args.guide!=='string' || args.name!==undefined || args.sdk===true)))
      throw Error('Use {}, {name}, {guide}, or {sdk:true}, optionally with a name for the SDK and a page cursor.')
    signal.throwIfAborted()
    const context = {agent,scope:agent,session:agent.session,toolSet,signal,modelSelection:selection}
    const assembly = await ctx.systemPrompt.assemble(context)
    signal.throwIfAborted()
    const bindingSdk = admitted.has(args.name) && assembly.tools.some(tool => tool.name === 'run_code')
      ? await singleBindingSdk(ctx,context,args.name) : undefined
    signal.throwIfAborted()
    const visible = toolSet.view(agent)
    if (visible.get(name)!==help) throw Error('Tool help is no longer available in this step.')
    if (visible.size !== admitted.size || [...admitted].some(([key, definition]) => visible.get(key) !== definition))
      throw Error('The set of admitted tools changed while preparing help. Request the current page again.')
    return page(reference(ctx,assembly,visible,agent,args,bindingSdk), [args.name??null,args.guide??null,args.sdk===true], args.cursor)
  }}
  ctx.tools.register(help,{when:({modelSelection})=>modelSelection.provider===selection.provider && modelSelection.model===selection.model})
  ctx.systemPrompt.section({name:sectionName,order:ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),interpolate:false,
    text:({scope,toolSet})=>toolSet?.view(scope).get(name)===help ? marker : ''})
}
