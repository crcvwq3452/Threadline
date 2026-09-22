/**
 * History backfill persistence.
 *
 * Shared persistence helper used by:
 *   - ChatGPT backend-API history sync (full conversations, markdown source)
 *   - live CAPTURE_MESSAGE path (upsert partial → complete assistant replies)
 */
import type { MemoryRecord } from '../types/memory'
import { db, safeAddRecord } from './db'
import { expandToChunks } from './chunking'
import { queueEmbedding } from './offscreen'
import { miniSearch } from './search'
import { reconstructLogicalContent } from '../recovery/logical-content'
import { mergeIncomingWithAuthoritativeGraph } from '../recovery/graph-authority'

export type PersistResult = 'added' | 'updated' | 'skipped'

function indexChunk(chunk: MemoryRecord): void {
  try {
    miniSearch.add(chunk)
  } catch {
    /* duplicate id — already indexed */
  }
}

/**
 * Persist one logical record (auto-chunked). Returns whether it was added,
 * updated (existing id, changed content) or skipped (existing id, same text).
 *
 * Long content is stored as chunk records ONLY (ids `<id>-c0`, `<id>-c1` …).
 * When a stronger raw/provider graph representation already exists, weaker
 * history/live enrichment cannot replace its graph lineage.
 */
export async function persistRecordWithChunks(
  record: MemoryRecord,
): Promise<PersistResult> {
  const existing = await db.memories.get(record.id)
  const existingChunks = existing
    ? []
    : await db.memories.where('parentId').equals(record.id).toArray()
  const hasExisting = !!existing && !existing.isDeleted
  const hasChunks = existingChunks.length > 0

  if (!hasExisting && !hasChunks) {
    for (const chunk of expandToChunks(record)) {
      const id = await safeAddRecord(chunk)
      if (id) {
        indexChunk(chunk)
        queueEmbedding(chunk)
      }
    }
    return 'added'
  }

  const storedLogical = hasExisting
    ? existing.content
    : reconstructLogicalContent(existingChunks)
  if (storedLogical === record.content) return 'skipped'

  // Carry stronger raw/provider graph identity into any replacement physical
  // records. New chunk offsets are generated after this merge.
  const authoritySource = hasExisting
    ? existing
    : [...existingChunks].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))[0]
  const writeRecord = authoritySource
    ? mergeIncomingWithAuthoritativeGraph(authoritySource, record)
    : record

  const chunks = expandToChunks(writeRecord)
  const isLong = chunks.length > 1

  const staleRecords = existingChunks.length > 0
    ? existingChunks
    : await db.memories.where('parentId').equals(record.id).toArray()
  await db.memories.where('parentId').equals(record.id).delete()
  if (isLong && hasExisting) {
    staleRecords.push(existing)
    await db.memories.delete(existing.id)
  }
  for (const stale of staleRecords) {
    try {
      miniSearch.remove(stale)
    } catch {
      /* not indexed */
    }
  }

  if (isLong) {
    for (const chunk of chunks) {
      const id = await safeAddRecord(chunk)
      if (id) {
        indexChunk(chunk)
        queueEmbedding(chunk)
      }
    }
    return 'updated'
  }

  const patch: Partial<MemoryRecord> = {
    content: writeRecord.content,
    timestamp: writeRecord.timestamp,
    isPartial: writeRecord.isPartial ?? false,
    hasEmbedding: 0,
    embedding: undefined,
  }
  if (writeRecord.model) patch.model = writeRecord.model
  if (writeRecord.conversationTitle) patch.conversationTitle = writeRecord.conversationTitle

  if (hasExisting) {
    await db.memories.update(record.id, patch)
  } else {
    await db.memories.add({ ...writeRecord, hasEmbedding: 0 } as MemoryRecord)
  }

  try {
    miniSearch.remove({ ...writeRecord, hasEmbedding: 0 })
  } catch {
    /* not indexed */
  }
  indexChunk({ ...writeRecord, hasEmbedding: 0 })
  queueEmbedding({ ...writeRecord, hasEmbedding: 0 })
  return 'updated'
}

/** Persist a full parsed ChatGPT conversation and update its stored title. */
export async function persistChatGPTConversation(
  records: MemoryRecord[],
  title?: string,
): Promise<{ added: number; updated: number; skipped: number }> {
  let added = 0
  let updated = 0
  let skipped = 0
  for (const record of records) {
    const result = await persistRecordWithChunks(record)
    if (result === 'added') added += 1
    else if (result === 'updated') updated += 1
    else skipped += 1
  }
  const sessionId = records[0]?.sessionId
  if (sessionId && title?.trim()) void db.upsertConversationTitle(sessionId, title.trim())
  return { added, updated, skipped }
}
