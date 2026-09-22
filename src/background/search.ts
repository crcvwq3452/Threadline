/**
 * Hybrid search over stored memory records.
 *
 * Recovery policy:
 *   - raw recovered archives never age-decay out of semantic recall;
 *   - lexical retrieval tries strict AND first, then OR only when strict is empty;
 *   - strong lexical evidence keeps lexical ordering authoritative;
 *   - semantic/vector evidence reranks only when lexical evidence is weak;
 *   - physical chunks are reconstructed into exact logical-message content.
 */
import MiniSearch from 'minisearch'
import type { MemoryRecord } from '../types/memory'
import { db } from './db'
import type { SearchMemoriesRequest, SearchMemoriesResponse, SearchResult } from '../types/messages'
import { tryReconstructLogicalContent } from '../recovery/logical-content'
import {
  applyTemporalDecay,
  buildRecordToGroupMap,
  collectUniqueKeywordGroups,
  keywordSearchWithFallback,
  shouldPermitSemanticRerank,
} from '../recovery/search-policy'

// ─── MiniSearch Setup ─────────────────────────────────────────────────────────
export const miniSearch = new MiniSearch<MemoryRecord>({
  idField: 'id',
  fields: ['content'],
  storeFields: ['id', 'createdAt'],
})

/** Rebuild keyword index from Dexie. */
export async function hydrateSearchIndex(): Promise<void> {
  try {
    const all = await db.memories.filter((r) => !r.isDeleted).toArray()
    miniSearch.removeAll()
    if (all.length > 0) miniSearch.addAll(all)
  } catch (err) {
    console.warn('[Threadline] MiniSearch hydration failed:', err)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/** Group key: standalone record = record.id, chunk = record.parentId. */
function groupKey(r: MemoryRecord): string {
  return r.parentId ?? r.id
}

/** Build one SearchResult from a logical message (single record or merged chunks). */
function toSearchResult(records: MemoryRecord[], similarityScore: number): SearchResult | null {
  const sorted = [...records].sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
  const first = sorted[0]!
  const reconstruction = tryReconstructLogicalContent(sorted)
  if (!reconstruction.complete) return null
  return {
    id: first.parentId ?? first.id,
    role: first.role,
    content: reconstruction.content,
    sessionId: first.sessionId,
    provider: first.provider,
    timestamp: first.timestamp,
    createdAt: first.createdAt,
    parentId: first.parentId,
    chunkIndex: undefined,
    conversationTitle: first.conversationTitle,
    roundIndex: first.roundIndex,
    branchIndex: first.branchIndex,
    originalMessageId: first.originalMessageId,
    metadata: first.metadata,
    similarityScore,
  }
}

// Time-decay constant for non-archive memories: λ = 0.01 → half-life ≈ 69 days.
const LAMBDA = 0.01
// RRF smoothing constant (standard value).
const RRF_K = 60
// Scores below this are treated as semantic noise.
const VECTOR_THRESHOLD = 0.25
// Bound each retrieval route before fusion.
const POOL_SIZE = 50

export async function handleSearchMemories(
  message: SearchMemoriesRequest,
  embedViaOffscreen: (text: string) => Promise<Float32Array>,
): Promise<SearchMemoriesResponse> {
  const { query, topK = 5 } = message.payload

  const all = await db.memories.filter((r) => !r.isDeleted).toArray()
  if (all.length === 0) {
    return {
      type: 'SEARCH_MEMORIES_RESPONSE',
      payload: { results: [], query, reason: 'EMPTY_MEMORY_DB' },
    }
  }

  // Build lookup maps once for both routes and the merge step.
  const groupRecords = new Map<string, MemoryRecord[]>()
  for (const r of all) {
    const key = groupKey(r)
    const list = groupRecords.get(key) ?? []
    list.push(r)
    groupRecords.set(key, list)
  }
  const recordToGroup = buildRecordToGroupMap(all)

  // ── Route A: Vector + conditional time decay ───────────────────────────────
  const vectorGroupScores = new Map<string, number>()
  const vectorRecords = all.filter((r) => !!r.embedding)

  let queryEmbedding: Float32Array | null = null
  if (vectorRecords.length > 0) {
    try {
      queryEmbedding = await embedViaOffscreen(query)
    } catch (err) {
      console.warn('[Threadline] Search: failed to embed query', err)
    }
  }

  if (queryEmbedding) {
    const now = Date.now()
    for (const r of vectorRecords) {
      const baseScore = dotProduct(queryEmbedding, r.embedding as Float32Array)
      if (baseScore < VECTOR_THRESHOLD) continue

      const scored = applyTemporalDecay(baseScore, r, now, LAMBDA)
      const key = groupKey(r)
      const best = vectorGroupScores.get(key)
      if (best === undefined || scored > best) vectorGroupScores.set(key, scored)
    }
  }

  const vectorRanked = [...vectorGroupScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, POOL_SIZE)
    .map(([key]) => key)

  // ── Route B: Keyword search (strict AND, then OR fallback) ────────────────
  const keyword = keywordSearchWithFallback((combineWith) =>
    miniSearch.search(query, { fuzzy: 0.2, combineWith }).map((hit) => ({
      id: String(hit.id),
      score: hit.score,
      queryTerms: hit.queryTerms,
    })),
  )
  const kwHits = keyword.results
  const kwRanked = collectUniqueKeywordGroups(kwHits, recordToGroup, POOL_SIZE)

  // Strict AND is inherently high-confidence. On OR fallback, use query-term
  // coverage to decide whether semantic evidence may reorder lexical results.
  const strongLexical = kwRanked.length > 0 && (
    keyword.mode === 'AND' || !shouldPermitSemanticRerank(query, kwHits[0])
  )

  const finalScores = new Map<string, number>()
  let topKeys: string[]

  if (strongLexical) {
    kwRanked.forEach((key, idx) => {
      finalScores.set(key, 1 / (RRF_K + idx + 1))
    })
    const lexicalSet = new Set(kwRanked)
    const semanticExtras = vectorRanked.filter((key) => !lexicalSet.has(key))
    semanticExtras.forEach((key, idx) => {
      finalScores.set(key, 1 / (RRF_K + kwRanked.length + idx + 1))
    })
    topKeys = [...kwRanked, ...semanticExtras].slice(0, topK)
  } else {
    // Weak/no lexical evidence: use the existing reciprocal-rank fusion policy.
    vectorRanked.forEach((key, idx) => {
      finalScores.set(key, 1 / (RRF_K + idx + 1))
    })
    kwRanked.forEach((key, idx) => {
      const prev = finalScores.get(key) ?? 0
      finalScores.set(key, prev + 1 / (RRF_K + idx + 1))
    })

    if (finalScores.size === 0) {
      return {
        type: 'SEARCH_MEMORIES_RESPONSE',
        payload: { results: [], query, reason: 'NO_MATCHES' },
      }
    }

    topKeys = [...finalScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([key]) => key)
  }

  if (topKeys.length === 0) {
    return {
      type: 'SEARCH_MEMORIES_RESPONSE',
      payload: { results: [], query, reason: 'NO_MATCHES' },
    }
  }

  const results: SearchResult[] = topKeys
    .filter((key) => groupRecords.has(key))
    .map((key) => toSearchResult(groupRecords.get(key)!, finalScores.get(key) ?? 0))
    .filter((result): result is SearchResult => result !== null)

  return { type: 'SEARCH_MEMORIES_RESPONSE', payload: { results, query } }
}
