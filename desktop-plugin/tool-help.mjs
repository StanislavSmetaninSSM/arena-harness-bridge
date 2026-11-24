import { createHash } from 'node:crypto'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'

const name = 'arena_tool_help'
const sectionName = 'arena:tool-help'
const marker = 'Arena tool reference is available for this step through arena_tool_help.'
const selection = {provider:'arena', model:'agent-mode'}
const usage = 'Before using an unfamiliar Harness tool, look it up here. Omit arguments to list available names; use name for its documentation, guide for a listed shared instruction, or sdk:true for the native run_code guide. Repeat the same query with nextCursor as cursor for more.'
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
export function committedSection(messages, sectionName) {
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

// Harness publishes both per-tool and shared tool:* instructions. It has no
// family membership field. Keep every published shared topic discoverable by
// its own ID. Name matching only selects convenient inline suggestions.
function reference(ctx, assembly, visible, agent, args) {
  const runCode = assembly.tools.find(tool => tool.name === 'run_code')
  const active = assembly.sections.filter(section => !section.retire && !section.complete && section.text?.trim())
  const render = section => renderPrompt({...assembly, sections:[section]})
  // A scope mask also hides a registration from get(name, agent). Check its
  // declaring ancestors before treating the same ID as an independent guide.
  const scopes = [...scopeChainOf(agent), undefined]
  const guides = active.filter(section => {
    if (!section.name.startsWith('tool:')) return false
    const owner = section.name.slice(5)
    return visible.has(owner) || !scopes.some(scope => ctx.tools.get(owner, scope))
  })
  if (args.guide !== undefined) {
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
    if (runCode) names.add(runCode.name)
    const intro = runCode ? 'Inside run_code use await tools[name](args). The direct transport is run_code.'
      : 'Use the listed Harness tools directly.'
    const topics = guides.map(section => section.name).sort()
    return [intro, ...[...names].sort(), '', 'Published instructions (request with guide):', ...topics].join('\n')
  }
  const tool = definition ?? (args.name === runCode?.name ? runCode : undefined)
  if (!tool) return 'Tool unavailable in this step. Request the current list with {}.'
  const entry = {name:tool.name, description:tool.description, parameters:tool.parameters}
  const parts = []
  if (definition && sdk) {
    const native = renderToolsSdk([{...entry, output:definition.output.schema}], ctx.get('ptcRuntime')?.programFormat)
    // A presentation shortcut only. When the native renderer changes its
    // layout, the lossless per-binding SDK remains available in full.
    const outputMap = /^interface ToolOutputMap \{[\s\S]*?^\}/m.exec(native)?.[0]
    if (args.sdk) return outputMap ? outputMap+'\n\n'+native : native
    if (outputMap) parts.push('Return value inside run_code:\n'+outputMap)
    else parts.push('Request {name, sdk:true} for this binding\'s native program types.')
  } else if (args.sdk) {
    return 'No program executor SDK is available in this step.'
  }
  if (definition) entry.canonicalOutput = definition.output.schema
  const words = new Set(args.name.toLowerCase().split(/[_-]/))
  for (const section of guides) {
    const group = section.name.slice(5).toLowerCase()
    const mentioned = section.text.match(/[\p{L}\p{N}_-]+/gu)?.includes(args.name)
    if (group === args.name || words.has(group) || mentioned) parts.push(section.name+'\n'+render(section))
  }
  parts.push(JSON.stringify(entry,null,2))
  return parts.join('\n\n')
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
    const assembly = await ctx.systemPrompt.assemble({agent,scope:agent,session:agent.session,toolSet,signal,modelSelection:selection})
    signal.throwIfAborted()
    const visible = toolSet.view(agent)
    if (visible.get(name)!==help) throw Error('Tool help is no longer available in this step.')
    if (visible.size !== admitted.size || [...admitted].some(([key, definition]) => visible.get(key) !== definition))
      throw Error('The set of admitted tools changed while preparing help. Request the current page again.')
    return page(reference(ctx,assembly,visible,agent,args), [args.name??null,args.guide??null,args.sdk===true], args.cursor)
  }}
  ctx.tools.register(help,{when:({modelSelection})=>modelSelection.provider===selection.provider && modelSelection.model===selection.model})
  ctx.systemPrompt.section({name:sectionName,order:ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),interpolate:false,
    text:({scope,toolSet})=>toolSet?.view(scope).get(name)===help ? marker : ''})
}
