/** Drop-in replacement for PR #6 src/background/chunking.ts. */
import type { MemoryRecord } from '../types/memory'
import {
  LIVE_CHUNK_SIZE_UTF16,
  LIVE_CHUNK_OVERLAP_UTF16,
  chunkLiveTextWithOffsets,
  expandLiveRecordToChunks,
} from '../recovery/live-chunking'

export const CHUNK_SIZE_CHARS = LIVE_CHUNK_SIZE_UTF16
export const CHUNK_OVERLAP_CHARS = LIVE_CHUNK_OVERLAP_UTF16

export function chunkText(text: string): string[] {
  return chunkLiveTextWithOffsets(text).map((chunk) => chunk.content)
}

export function expandToChunks(record: MemoryRecord): MemoryRecord[] {
  return expandLiveRecordToChunks(record) as MemoryRecord[]
}
