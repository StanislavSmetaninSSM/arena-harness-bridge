import { createHash } from 'node:crypto'
import { lookup } from 'mime-types'

const chunkBytes = 256 * 1024

// Harness presents file handles to models as text. Only the exact structured
// occurrence in this user's durable message authorizes reading its bytes.
export function selectedFileRefs(ctx, agent, message) {
  const refs = new Map()
  if (message.role !== 'user' || message.source?.kind !== 'user' || !agent?.session?.deriveMessages) return refs
  const original = agent.session.deriveMessages().findLast(row =>
    row.id === message.id && row.role === 'user' && row.source?.kind === 'user')
  if (!original?.content.some(block => block.type === 'file')) return refs
  if (original.content.length !== message.content.length)
    throw Error('The Desktop attachment list changed before upload. Reattach the original files.')
  for (const [index,source] of original.content.entries()) {
    if (source.type !== 'file') continue
    const block = message.content[index]
    const ref = source.attachment
    if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 ||
        typeof ref.name !== 'string' || !ref.name.length)
      throw Error('Desktop returned an invalid reference for a selected file.')
    if (source.offloaded || block.offloaded || block.type !== 'text' || block.text !== ctx.llm.fileRequestText(ref))
      throw Error('The selected file is no longer available in this Desktop request. Reattach the original file.')
    refs.set(index, ref)
  }
  return refs
}

export function fileMetadata(ref) {
  return {name:ref.name,mediaType:lookup(ref.name) || '',size:ref.bytes,sha256:ref.attachmentId.slice(7)}
}

// Exceptional names travel in a small header in one native, immutable file.
// The read address always comes from a selected native FileAttachmentRef.
async function originalMetadata(store, ref, signal) {
  const marker = /^arena-file-([0-9a-f-]{36})-([0-9]{1,5})\.bin$/i.exec(ref.name)
  const length = marker && Number(marker[2])
  if (!length || length > 8192 || length > ref.bytes) return
  const header = Buffer.alloc(length), hash = createHash('sha256')
  let copied = 0, received = 0
  for await (const chunk of store.readFileStream(ref,signal)) {
    signal?.throwIfAborted()
    const bytes = Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength)
    const count = Math.min(bytes.length,length-copied)
    if (count) {bytes.copy(header,copied,0,count); copied+=count}
    hash.update(bytes.subarray(count))
    received += bytes.length
  }
  if (received !== ref.bytes) throw Error('The stored Desktop attachment changed size.')
  let info
  try {info=JSON.parse(header.toString('utf8'))} catch {return}
  if (info?.id !== marker[1] || typeof info.name !== 'string' || !info.name ||
      /[\/\\\x00]/.test(info.name) || info.name==='.' || info.name==='..' || typeof info.mediaType !== 'string') return
  return {name:info.name,mediaType:info.mediaType || lookup(info.name) || '',size:received-length,sha256:hash.digest('hex')}
}

export async function stageFiles(companion, store, request, signal) {
  if (!store?.readFileStream) throw Error('The Desktop file storage service is unavailable.')
  const staged = new Set()
  for (const [index,stored] of request.files.entries()) {
    signal?.throwIfAborted()
    const ref = {attachmentId:'sha256:'+stored.sha256,name:stored.name,bytes:stored.size}
    const file = await originalMetadata(store,ref,signal) ?? stored
    request.files[index] = file
    if (staged.has(file.sha256)) continue
    let skip = ref.bytes - file.size
    let offset = 0
    const send = async bytes => {
      signal?.throwIfAborted()
      const reply = await companion.rpc('stageFileChunk',{requestId:request.requestId,sessionId:request.sessionId,
        sha256:file.sha256,size:file.size,offset,data:bytes.toString('base64')})
      offset += bytes.length
      if (reply?.nextOffset !== offset) throw Error('The Arena companion did not confirm the file chunk.')
    }
    // Receipts are keyed by offsets. A retried immutable file must produce
    // the same chunks even when the store yields different-sized fragments.
    const buffer = Buffer.allocUnsafe(Math.min(file.size,chunkBytes))
    let used = 0
    for await (const chunk of store.readFileStream(ref,signal)) {
      const prefix = Math.min(skip,chunk.byteLength)
      skip -= prefix
      const bytes = Buffer.from(chunk.buffer,chunk.byteOffset+prefix,chunk.byteLength-prefix)
      if (offset + used + bytes.length > file.size) throw Error('The selected Desktop file exceeds its recorded size.')
      for (let start=0; start<bytes.length;) {
        const count = Math.min(buffer.length-used,bytes.length-start)
        bytes.copy(buffer,used,start,start+count)
        used += count
        start += count
        if (used === buffer.length) {
          await send(buffer)
          used = 0
        }
      }
    }
    if (offset + used !== file.size) throw Error('The selected Desktop file is shorter than its recorded size.')
    if (used || !file.size) await send(buffer.subarray(0,used))
    staged.add(file.sha256)
  }
}
