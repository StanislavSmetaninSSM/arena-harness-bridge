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
  return {
    name:batchName,
    description:'Send two or more independent text inspections in one Desktop call. Use the native arguments for each tool. Results arrive in call order with individual IDs, status and output.',
    parameters:{type:'object', additionalProperties:false, required:['calls'],
      properties:{calls:{type:'array',minItems:2,items:member}}},
  }
}

// Both supported PTC executors build the runtime's tools namespace from the
// step view. Their reserved transport and scoped SDK sections identify it;
// an unrelated schema named run_code does not establish any nested bindings.
export function programToolRoutes(ctx, agent, toolSet, directTools, sections) {
  if (!agent || !toolSet || !directTools?.some(tool=>tool.name==='run_code')) return
  const active = key => sections?.some(item => item.name === key && !item.retire && !item.complete && item.text?.trim())
  if (!active('tools:ptc-only') || !active('tools:sdk')) return
  const language = ctx.get?.('ptcRuntime')?.language
  if (language !== 'typescript' && language !== 'python') return
  return {language,names:[...toolSet.view(agent).keys()].sort()}
}

// Harness publishes per-tool and shared tool:* instructions without a family
// membership field. Shared topics are discoverable by their own section IDs.
function reference(ctx, assembly, visible, agent, args, program, bindingSdk) {
  const active = assembly.sections.filter(section => !section.retire && !section.complete && section.text?.trim())
  const render = section => renderPrompt({...assembly, sections:[section]})
  // The bridge's batch and literal script forms operate on direct wire calls.
  const direct = new Map(assembly.tools.filter(tool=>tool.name!==batchName).map(tool=>[tool.name,tool]))
  const nested = new Set(program?.names)
  const callable = toolName => direct.has(toolName) || nested.has(toolName)
  const hasCua = cuaNames.some(toolName => callable(toolName) && visible.has(toolName))
  const batchMembers = [...batchTools].filter(toolName => direct.has(toolName)).sort()
  if (batchMembers.length) direct.set(batchName,batchReference(batchMembers))
  const cua = hasCua && active.find(section => section.name === cuaTopic)
  const cuaHelp = () => cua ? render(cua) : 'Computer Use guidance is unavailable in this step. Wait for current guidance before using Computer Use.'
  // A scope mask also hides a registration from get(name, agent). Check its
  // declaring ancestors before treating the same ID as an independent guide.
  const scopes = [...scopeChainOf(agent), undefined]
  const guides = active.filter(section => {
    if (!section.name.startsWith('tool:')) return false
    const owner = section.name.slice(5)
    if (owner === batchName && !nested.has(owner)) return false
    if (visible.has(owner)) return callable(owner)
    if (cuaNames.includes(owner)) return false
    return !scopes.some(scope => ctx.tools.get(owner, scope))
  })
  if (args.guide !== undefined) {
    if (args.guide === cuaTopic) return cuaHelp()
    if (args.guide === imageTopic) return [
      "Generate images with Arena's own image tool. When Arena shows a choice panel, the bridge sends its previews to Desktop.",
      "The user chooses a variant. Wait for their choice, then continue in Arena.",
      "Once Arena shows the finished images in your reply, finish your answer normally. The bridge automatically delivers each displayed image to Desktop.",
    ].join(' ')
    const guide = guides.find(section => section.name === args.guide)
    return guide ? render(guide) : 'Tool guide unavailable. Request {} for published topics.'
  }

  const definition = visible.get(args.name)
  const sdk = program && active.find(section => section.name === 'tools:sdk')
  if (args.sdk && (args.name === undefined || args.name === 'run_code')) {
    return sdk ? render(sdk) : 'No program executor SDK is available in this step.'
  }
  if (args.name === undefined) {
    const topics = [imageTopic,...guides.map(section => section.name)]
    if (cua) topics.push(cuaTopic)
    const lines = ['Direct Desktop calls (request help with name):', ...[...direct.keys()].sort()]
    if (program) lines.push('', 'Inside run_code ('+program.language+'), request help with name:', ...program.names,
      'Request {sdk:true} for the native program SDK.')
    lines.push('', 'Published instructions (request with guide):', ...topics.sort())
    if (callable('skill') && visible.has('skill')) lines.push('', 'For available skills, request {name:"skill"}.')
    return lines.join('\n')
  }
  if (args.sdk && args.name === batchName && batchMembers.length && !nested.has(batchName))
    return 'The read batch is a direct Desktop call.'
  const outer = direct.get(args.name)
  const binding = nested.has(args.name) && definition
  if (!outer && !binding) return 'Tool unavailable in this step. Request the current list with {}.'
  const schema = (tool, output) => JSON.stringify({
    name:tool.name,description:tool.description,parameters:tool.parameters,canonicalOutput:output,
  },null,2)
  const parts = []
  if (outer) parts.push('Direct Desktop call: use '+JSON.stringify(args.name)+' as the tool name.\n'+
    schema(outer,binding || args.name === batchName ? undefined : definition?.output.schema))
  if (binding) parts.push('Inside run_code ('+program.language+'): await tools['+JSON.stringify(args.name)+'](args). Pass the arguments below as one '+
    (program.language==='python'?'Python dictionary.':'object.')+'\n'+schema(binding,binding.output.schema))
  if (binding && sdk && bindingSdk) {
    // A presentation shortcut only. When the native renderer changes its
    // layout, the lossless per-binding SDK remains available in full.
    const outputMap = /^interface ToolOutputMap \{[\s\S]*?^\}/m.exec(bindingSdk)?.[0]
    if (args.sdk) return outputMap ? outputMap+'\n\n'+bindingSdk : bindingSdk
    if (outputMap) parts.push('Return value inside run_code:\n'+outputMap)
    else parts.push('Request {name, sdk:true} for this binding\'s native program types.')
  } else if (args.sdk) {
    return 'No program executor SDK is available in this step.'
  }
  if (cuaNames.includes(args.name)) parts.push(cuaHelp())
  if (args.name === 'pwsh' && direct.has('pwsh')) parts.push(literalScriptHelp)
  if (args.name === 'skill' && definition) {
    const skills = currentSkills(agent)
    parts.push(skills.length ? ['Available skills:',...skills.map(entry => entry.name+' — '+entry.description)].join('\n') : 'No skills are listed in the current catalog.')
  }
  const guide = guides.find(section => section.name === 'tool:'+args.name)
  if (guide) parts.push(guide.name+'\n'+render(guide))
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
    const program = programToolRoutes(ctx,agent,toolSet,assembly.tools,assembly.sections)
    const alias = args.guide?.startsWith('tool:') ? args.guide.slice(5) : undefined
    const query = alias && (assembly.tools.some(tool=>tool.name===alias || (alias===batchName && batchTools.has(tool.name))) || program?.names.includes(alias))
      ? {name:alias} : args
    const bindingSdk = program?.names.includes(query.name) ? await singleBindingSdk(ctx,context,query.name) : undefined
    signal.throwIfAborted()
    const visible = toolSet.view(agent)
    if (visible.get(name)!==help) throw Error('Tool help is no longer available in this step.')
    if (visible.size !== admitted.size || [...admitted].some(([key, definition]) => visible.get(key) !== definition))
      throw Error('The set of admitted tools changed while preparing help. Request the current page again.')
    return page(reference(ctx,assembly,visible,agent,query,program,bindingSdk), [args.name??null,args.guide??null,args.sdk===true], args.cursor)
  }}
  ctx.tools.register(help,{when:({modelSelection})=>modelSelection.provider===selection.provider && modelSelection.model===selection.model})
  ctx.systemPrompt.section({name:sectionName,order:ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),interpolate:false,
    text:({scope,toolSet})=>toolSet?.view(scope).get(name)===help ? marker : ''})
}
