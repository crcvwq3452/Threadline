/**
 * History backfill persistence.
 *
 * Shared persistence helper used by:
 *   - ChatGPT backend-API history sync (full conversations, markdown source)
 *   - live CAPTURE_MESSAGE path (upsert partial → complete assistant replies)
 *
 * Dedup semantics:
 *   - id unknown            → add (chunked) + index + queue embedding
 *   - id exists, same text  → skip
 *   - id exists, new text   → update in place, replace stale chunks, drop the
 *     old embedding (hasEmbedding = 0) and re-queue embedding
 */

import type { MemoryRecord } from "../types/memory";
import { db, safeAddRecord } from "./db";
import { expandToChunks } from "./chunking";
import { queueEmbedding } from "./offscreen";
import { miniSearch } from "./search";

export type PersistResult = "added" | "updated" | "skipped";

function indexChunk(chunk: MemoryRecord): void {
  try {
    miniSearch.add(chunk);
  } catch {
    /* duplicate id — already indexed */
  }
}

/**
 * Persist one logical record (auto-chunked). Returns whether it was added,
 * updated (existing id, changed content) or skipped (existing id, same text).
 */
export async function persistRecordWithChunks(
  record: MemoryRecord,
): Promise<PersistResult> {
  const existing = await db.memories.get(record.id);

  if (!existing || existing.isDeleted) {
    for (const chunk of expandToChunks(record)) {
      const id = await safeAddRecord(chunk);
      if (id) {
        indexChunk(chunk);
        queueEmbedding(chunk);
      }
    }
    return "added";
  }

  if (existing.content === record.content) return "skipped";

  // ── Content changed → replace in place ───────────────────────────────────
  const chunks = expandToChunks(record);
  const patch: Partial<MemoryRecord> = {
    content: record.content,
    timestamp: record.timestamp,
    isPartial: record.isPartial ?? false,
    hasEmbedding: 0,
    embedding: undefined,
  };
  if (record.model) patch.model = record.model;
  if (record.conversationTitle) patch.conversationTitle = record.conversationTitle;

  if (chunks.length === 1) {
    await db.memories.update(record.id, patch);
    try {
      miniSearch.remove(record.id);
    } catch {
      /* not indexed */
    }
    indexChunk(chunks[0]);
    queueEmbedding(chunks[0]);
    return "updated";
  }

  // Long content: replace every chunk record under the parent id.
  const oldChunks = await db.memories
    .where("parentId")
    .equals(record.id)
    .toArray();
  for (const old of oldChunks) {
    try {
      miniSearch.remove(old.id);
    } catch {
      /* not indexed */
    }
  }
  await db.memories.where("parentId").equals(record.id).delete();
  for (const chunk of chunks) {
    const id = await safeAddRecord(chunk);
    if (id) {
      indexChunk(chunk);
      queueEmbedding(chunk);
    }
  }
  return "updated";
}

/**
 * Persist a full parsed ChatGPT conversation (records already normalized by
 * parseChatGPTConversationDetail) and update its stored title.
 */
export async function persistChatGPTConversation(
  records: MemoryRecord[],
  title?: string,
): Promise<{ added: number; updated: number; skipped: number }> {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const record of records) {
    const result = await persistRecordWithChunks(record);
    if (result === "added") added += 1;
    else if (result === "updated") updated += 1;
    else skipped += 1;
  }
  const sessionId = records[0]?.sessionId;
  if (sessionId && title?.trim()) {
    void db.upsertConversationTitle(sessionId, title.trim());
  }
  return { added, updated, skipped };
}
