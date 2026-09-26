/**
 * History backfill persistence.
 *
 * Shared persistence helper used by:
 *   - ChatGPT backend-API history sync (full conversations, markdown source)
 *   - live CAPTURE_MESSAGE path (upsert partial → complete assistant replies)
 */
import type { MemoryRecord } from '../types/memory'
import { db } from './db'
import { expandToChunks } from './chunking'
import { queueEmbedding } from './offscreen'
import { miniSearch } from './search'
import { tryReconstructLogicalContent } from '../recovery/logical-content'
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

  let storedLogical: string | undefined
  let storedComplete = true
  if (hasExisting) {
    storedLogical = existing.content
  } else if (hasChunks) {
    const reconstruction = tryReconstructLogicalContent(existingChunks)
    storedLogical = reconstruction.content
    storedComplete = reconstruction.complete
  }

  if ((hasExisting || hasChunks) && storedComplete && storedLogical === record.content) {
    return 'skipped'
  }

  // Carry stronger raw/provider graph identity into the replacement physical
  // records. Incomplete existing groups are deliberately replaced rather than
  // trusted or concatenated as canonical content.
  const authoritySource = hasExisting
    ? existing
    : [...existingChunks].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))[0]
  const writeRecord = authoritySource
    ? mergeIncomingWithAuthoritativeGraph(authoritySource, record)
    : record
  const physical = expandToChunks(writeRecord)

  const removed = await db.replaceLogicalRecordAtomically(record.id, physical)
  for (const stale of removed) {
    try {
      miniSearch.remove(stale)
    } catch {
      /* not indexed */
    }
  }
  for (const chunk of physical) {
    indexChunk(chunk)
    queueEmbedding(chunk)
  }

  return hasExisting || hasChunks ? 'updated' : 'added'
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
