import type { MemoryRecord } from './types'

const LEGACY_CHUNK_SIZE = 500
const LEGACY_OVERLAP = 75
const LEGACY_STEP = LEGACY_CHUNK_SIZE - LEGACY_OVERLAP

function numericMeta(record: MemoryRecord, key: string): number | undefined {
  const value = record.metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function byChunkIndex(a: MemoryRecord, b: MemoryRecord): number {
  return (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0)
}

function reconstructByOffsets(chunks: MemoryRecord[]): string | undefined {
  if (!chunks.every(c => numericMeta(c, 'chunkStartUtf16') !== undefined && numericMeta(c, 'chunkLengthUtf16') !== undefined)) return undefined
  let cursor = 0
  let out = ''
  for (const chunk of chunks) {
    const start = numericMeta(chunk, 'chunkStartUtf16')!
    const length = numericMeta(chunk, 'chunkLengthUtf16')!
    if (length !== chunk.content.length) throw new Error(`Chunk length metadata mismatch for ${chunk.id}`)
    if (start > cursor) throw new Error(`Chunk offset gap: expected <= ${cursor}, got ${start} for ${chunk.id}`)
    const overlap = cursor - start
    if (overlap > chunk.content.length) throw new Error(`Chunk offset overlap exceeds chunk length for ${chunk.id}`)
    if (overlap > 0) {
      const expected = out.slice(start, cursor)
      const actual = chunk.content.slice(0, overlap)
      if (expected !== actual) throw new Error(`Chunk overlap content mismatch for ${chunk.id}`)
    }
    out += chunk.content.slice(overlap)
    cursor = start + length
  }
  return out
}

function reconstructLegacyThreadlineOverlap(chunks: MemoryRecord[]): string | undefined {
  if (chunks.length < 2 || chunks[0].content.length !== LEGACY_CHUNK_SIZE) return undefined
  let out = chunks[0].content
  for (let i = 1; i < chunks.length; i += 1) {
    const expectedStart = i * LEGACY_STEP
    if (expectedStart > out.length) return undefined
    const overlap = out.length - expectedStart
    if (overlap < 0 || overlap > LEGACY_OVERLAP) return undefined
    if (overlap > chunks[i].content.length) return undefined
    if (overlap > 0) {
      const expected = out.slice(expectedStart)
      const actual = chunks[i].content.slice(0, overlap)
      if (expected !== actual) return undefined
    }
    out += chunks[i].content.slice(overlap)
  }
  return out
}

export function reconstructLogicalContent(records: MemoryRecord[]): string {
  if (records.length === 0) return ''
  const chunks = [...records].sort(byChunkIndex)
  if (chunks.length === 1) return chunks[0].content
  const byOffsets = reconstructByOffsets(chunks)
  if (byOffsets !== undefined) return byOffsets
  const legacy = reconstructLegacyThreadlineOverlap(chunks)
  if (legacy !== undefined) return legacy
  return chunks.map(c => c.content).join('')
}

export interface LogicalReconstructionResult {
  content: string
  complete: boolean
  error?: string
  firstStartUtf16?: number
}

function reconstructAvailableOffsetTail(chunks: MemoryRecord[]): { content: string; firstStartUtf16?: number } {
  const sorted = [...chunks].sort(byChunkIndex)
  const firstStart = numericMeta(sorted[0], 'chunkStartUtf16')
  if (firstStart === undefined) {
    return { content: sorted.map(c => c.content).join('') }
  }

  let cursor = firstStart
  let out = ''
  for (const chunk of sorted) {
    const start = numericMeta(chunk, 'chunkStartUtf16')
    const length = numericMeta(chunk, 'chunkLengthUtf16')
    if (start === undefined || length === undefined || length !== chunk.content.length) {
      out += chunk.content
      continue
    }
    if (start > cursor) {
      out += `\n[Threadline missing ${start - cursor} UTF-16 units]\n`
      cursor = start
    }
    const overlap = Math.max(0, cursor - start)
    out += chunk.content.slice(Math.min(overlap, chunk.content.length))
    cursor = Math.max(cursor, start + length)
  }
  return { content: out, firstStartUtf16: firstStart }
}

export function tryReconstructLogicalContent(records: MemoryRecord[]): LogicalReconstructionResult {
  try {
    return { content: reconstructLogicalContent(records), complete: true }
  } catch (err) {
    const partial = reconstructAvailableOffsetTail(records)
    return {
      content: partial.content,
      complete: false,
      error: err instanceof Error ? err.message : String(err),
      firstStartUtf16: partial.firstStartUtf16,
    }
  }
}

