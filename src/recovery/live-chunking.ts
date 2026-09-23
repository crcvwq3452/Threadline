import type { MemoryRecord } from './types'

export const LIVE_CHUNK_SIZE_UTF16 = 500
export const LIVE_CHUNK_OVERLAP_UTF16 = 75
export const LIVE_CHUNK_STEP_UTF16 = LIVE_CHUNK_SIZE_UTF16 - LIVE_CHUNK_OVERLAP_UTF16

function isHigh(code: number): boolean { return code >= 0xd800 && code <= 0xdbff }
function isLow(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff }
function safeStart(text: string, raw: number): number {
  if (raw <= 0 || raw >= text.length) return raw
  return isLow(text.charCodeAt(raw)) && isHigh(text.charCodeAt(raw - 1)) ? raw - 1 : raw
}
function safeEnd(text: string, start: number, raw: number): number {
  let end = Math.min(raw, text.length)
  if (end > start && end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end -= 1
  return end
}

export interface LiveChunk { content: string; startUtf16: number; lengthUtf16: number }

export function chunkLiveTextWithOffsets(text: string): LiveChunk[] {
  if (text.length <= LIVE_CHUNK_SIZE_UTF16) return [{content:text,startUtf16:0,lengthUtf16:text.length}]
  const chunks: LiveChunk[]=[]
  for (let rawStart=0; rawStart<text.length; rawStart+=LIVE_CHUNK_STEP_UTF16) {
    const start=safeStart(text,rawStart)
    const end=safeEnd(text,start,start+LIVE_CHUNK_SIZE_UTF16)
    if (end<=start) continue
    const content=text.slice(start,end)
    chunks.push({content,startUtf16:start,lengthUtf16:content.length})
  }
  return chunks
}

export function expandLiveRecordToChunks(record: MemoryRecord): MemoryRecord[] {
  const chunks=chunkLiveTextWithOffsets(record.content)
  // Preserve Threadline's existing identity/reference contract for records that
  // do not need chunking. Offset metadata is only required to reconstruct a
  // genuinely chunked logical message.
  if (chunks.length===1) return [record]
  return chunks.map((c,i)=>({
    ...record,id:`${record.id}-c${i}`,content:c.content,chunkIndex:i,parentId:record.id,
    metadata:{...(record.metadata??{}),chunkStartUtf16:c.startUtf16,chunkLengthUtf16:c.lengthUtf16},
  }))
}
