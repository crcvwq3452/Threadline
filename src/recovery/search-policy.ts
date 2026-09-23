import type { MemoryRecord } from './types'

export function isRecoveryArchive(record: Pick<MemoryRecord, 'metadata'>): boolean {
  return record.metadata?.['recoveryArchive'] === true
}

export function applyTemporalDecay(
  similarity: number,
  record: Pick<MemoryRecord, 'createdAt' | 'metadata'>,
  nowMs = Date.now(),
  lambdaPerDay = 0.01,
): number {
  if (isRecoveryArchive(record)) return similarity
  const daysOld = Math.max(0, nowMs - record.createdAt) / 86_400_000
  return similarity * Math.exp(-lambdaPerDay * daysOld)
}

export interface MiniSearchLikeResult { id: string; score?: number; queryTerms?: string[] }
export type KeywordSearch = (combineWith: 'AND' | 'OR') => MiniSearchLikeResult[]

export function keywordSearchWithFallback(run: KeywordSearch): { mode: 'AND' | 'OR'; results: MiniSearchLikeResult[] } {
  const strict = run('AND')
  if (strict.length > 0) return { mode: 'AND', results: strict }
  return { mode: 'OR', results: run('OR') }
}

export function tokenizeQuery(query: string): string[] {
  return [...new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}_#.-]+/gu) ?? []).filter(Boolean))]
}

export function lexicalCoverage(query: string, result?: Pick<MiniSearchLikeResult, 'queryTerms'>): number {
  const queryTerms = tokenizeQuery(query)
  if (queryTerms.length === 0) return 0
  const matched = new Set((result?.queryTerms ?? []).map(t => t.toLocaleLowerCase()))
  let count = 0
  for (const term of queryTerms) if (matched.has(term)) count += 1
  return count / queryTerms.length
}

export function shouldPermitSemanticRerank(
  query: string,
  topLexical: MiniSearchLikeResult | undefined,
  threshold = 0.75,
): boolean {
  if (!topLexical) return true
  return lexicalCoverage(query, topLexical) < threshold
}

export function buildRecordToGroupMap<T extends { id: string; parentId?: string }>(records: T[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const record of records) map.set(record.id, record.parentId ?? record.id)
  return map
}

export function collectUniqueKeywordGroups(
  hits: Array<{ id: string }>,
  recordToGroup: Map<string, string>,
  limit = 50,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const hit of hits) {
    const group = recordToGroup.get(hit.id)
    if (!group || seen.has(group)) continue
    seen.add(group)
    out.push(group)
    if (out.length >= limit) break
  }
  return out
}
