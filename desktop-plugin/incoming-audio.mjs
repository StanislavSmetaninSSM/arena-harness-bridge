import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const maxBytes = 8 * 1024 ** 2
const maxTracks = 20
const suffixes = new Map([
  ['audio/mpeg','mp3'], ['audio/wav','wav'], ['audio/x-wav','wav'],
  ['audio/ogg','ogg'], ['audio/mp4','m4a'], ['audio/webm','webm'], ['audio/flac','flac'],
])
const fileEnding = new RegExp(`^[a-f0-9]{24}\\.arena-audio\\.(?:${[...new Set(suffixes.values())].join('|')})$`)

export function choiceAudioLabels(items) {
  return Array.isArray(items) ? items.map((_, index) => `Voice Sample ${index + 1}`) : []
}

export function audioTrackLabels(count) {
  return 1 <= count && count <= maxTracks ? Array.from({length:count}, (_,index) => `Audio track ${index + 1}`) : []
}

export function matchesIncomingAudioLinks(text, callId, labels) {
  if (!/^arena_[a-f0-9]{64}$/.test(callId)) return false
  const lines = text.split('\n')
  return lines.length === labels.length && lines.every((line,index) => {
    const prefix = `- [${labels[index]}](<`
    if (!line.startsWith(prefix) || !line.endsWith('>)')) return false
    const address = line.slice(prefix.length,-2)
    if (/[<>\\\s]/.test(address)) return false
    const path = decodeURIComponent(address)
    const stem = `arena-${callId.slice(6,22)}-${index + 1}-`
    const filename = path.split('/').at(-1)
    return isAbsolute(path) && filename.startsWith(stem) && fileEnding.test(filename.slice(stem.length))
  })
}

export async function incomingAudioLinks(directory, items, requestId, labels, signal) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || !Array.isArray(items) ||
      !items.length || items.length > maxTracks || labels.length !== items.length) {
    throw Error('Invalid generated Arena audio batch')
  }
  let remaining = maxBytes
  const files = items.map((item, index) => {
    const suffix = suffixes.get(item?.mediaType)
    if (!suffix || typeof item.data !== 'string' || !item.data.length || item.data.length > 4 * Math.ceil(remaining / 3)) {
      throw Error('Unsupported or oversized generated Arena audio')
    }
    const bytes = Buffer.from(item.data, 'base64')
    if (bytes.length > remaining || bytes.toString('base64') !== item.data) {
      throw Error('Invalid generated Arena audio encoding')
    }
    remaining -= bytes.length
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
    const path = join(directory, `arena-${requestId.slice(0, 16)}-${index + 1}-${digest}.arena-audio.${suffix}`)
    return { bytes, path }
  })

  signal?.throwIfAborted()
  await mkdir(directory, { recursive:true, mode:0o700 })
  for (const {bytes,path} of files) {
    signal?.throwIfAborted()
    const temporary = join(directory, `${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag:'wx', mode:0o600 })
      signal?.throwIfAborted()
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force:true })
    }
  }
  return files.map(({path}, index) => {
    const address = path.replaceAll('\\','/').split('/').map(segment =>
      /^[a-z]:$/i.test(segment) ? segment : encodeURIComponent(segment)).join('/')
    return `- [${labels[index]}](<${address}>)`
  }).join('\n')
}
