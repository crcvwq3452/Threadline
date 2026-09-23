import type { MemoryRecord } from './types'

export const RECOVERY_CHUNK_SIZE_UTF16 = 500
const NATURAL_BREAK_SCAN = 120
const MIN_NATURAL_BREAK_FRACTION = 0.62

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }

function clampBoundary(text: string, start: number, end: number): number {
  let out = Math.min(end, text.length)
  if (out > start && out < text.length) {
    const prev = text.charCodeAt(out - 1)
    const next = text.charCodeAt(out)
    if (isHighSurrogate(prev) && isLowSurrogate(next)) out -= 1
  }
  return out
}

function naturalBoundary(text: string, start: number, hardEnd: number): number {
  if (hardEnd >= text.length) return hardEnd
  const min = Math.max(start + Math.floor(RECOVERY_CHUNK_SIZE_UTF16 * MIN_NATURAL_BREAK_FRACTION), hardEnd - NATURAL_BREAK_SCAN)
  const segment = text.slice(min, hardEnd)
  const priorities = ['\n\n', '\n', '. ', '! ', '? ', '; ', ': ', ', ', ' ']
  for (const token of priorities) {
    const idx = segment.lastIndexOf(token)
    if (idx >= 0) {
      const candidate = min + idx + token.length
      if (candidate > start) return clampBoundary(text, start, candidate)
    }
  }
  return hardEnd
}

export interface RecoveryChunk {
  content: string
  startUtf16: number
  lengthUtf16: number
}

export function chunkRecoveryText(text: string): RecoveryChunk[] {
  if (text.length <= RECOVERY_CHUNK_SIZE_UTF16) {
    return [{ content: text, startUtf16: 0, lengthUtf16: text.length }]
  }
  const out: RecoveryChunk[] = []
  let start = 0
  while (start < text.length) {
    let end = clampBoundary(text, start, start + RECOVERY_CHUNK_SIZE_UTF16)
    end = naturalBoundary(text, start, end)
    if (end <= start) end = clampBoundary(text, start, start + RECOVERY_CHUNK_SIZE_UTF16)
    if (end <= start) throw new Error(`Unable to advance recovery chunk boundary at UTF-16 offset ${start}`)
    const content = text.slice(start, end)
    if (content.length > RECOVERY_CHUNK_SIZE_UTF16) throw new Error('Recovery chunk exceeds 500 UTF-16 units')
    if (content.length && isLowSurrogate(content.charCodeAt(0))) throw new Error('Recovery chunk starts inside a surrogate pair')
    if (content.length && isHighSurrogate(content.charCodeAt(content.length - 1))) throw new Error('Recovery chunk ends inside a surrogate pair')
    out.push({ content, startUtf16: start, lengthUtf16: content.length })
    start = end
  }
  return out
}


function chunkMetadata(metadata: Record<string, unknown> | undefined, chunkIndex: number, startUtf16: number, lengthUtf16: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(metadata ?? {}), chunkStartUtf16: startUtf16, chunkLengthUtf16: lengthUtf16 }
  // Message-level provenance can be large. Keep it once on chunk 0; logical-message
  // reconstruction/grouping uses chunk 0 as the representative metadata record.
  if (chunkIndex > 0) {
    delete out['sourceReferences']
    delete out['sourceAttachments']
  }
  return out
}

export function expandRecoveryRecord(record: MemoryRecord): MemoryRecord[] {
  const chunks = chunkRecoveryText(record.content)
  if (chunks.length === 1) {
    return [{
      ...record,
      metadata: chunkMetadata(record.metadata, 0, 0, record.content.length),
    }]
  }
  return chunks.map((chunk, i) => ({
    ...record,
    id: `${record.id}-c${i}`,
    content: chunk.content,
    chunkIndex: i,
    parentId: record.id,
    metadata: chunkMetadata(record.metadata, i, chunk.startUtf16, chunk.lengthUtf16),
  }))
}
