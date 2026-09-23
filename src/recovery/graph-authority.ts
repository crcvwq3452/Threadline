import type { MemoryRecord } from './types'

const GRAPH_FIELDS = ['turnIndex', 'roundIndex', 'branchIndex', 'branchId', 'pathId', 'parentMessageId'] as const
const GRAPH_METADATA_FIELDS = new Set<string>([...GRAPH_FIELDS, 'onCurrentPath', 'branchStatus', 'sourceNodeId', 'sourceParentNodeId'])

export type DomGraphPatch = Partial<Pick<MemoryRecord,
  'turnIndex' | 'roundIndex' | 'branchIndex' | 'branchId' | 'pathId' | 'parentMessageId' | 'sourceUrl' | 'conversationTitle'
>> & { metadata?: Record<string, unknown> }

export function protectAuthoritativeGraphPatch(stored: MemoryRecord, incoming: DomGraphPatch): DomGraphPatch {
  const authority = stored.metadata?.['graphAuthority']
  if (authority !== 'raw_export' && authority !== 'provider_graph') return incoming
  const out: DomGraphPatch = {}
  if (incoming.sourceUrl !== undefined) out.sourceUrl = incoming.sourceUrl
  if (incoming.conversationTitle !== undefined) out.conversationTitle = incoming.conversationTitle
  if (incoming.metadata) {
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(incoming.metadata)) {
      if (!GRAPH_METADATA_FIELDS.has(key)) safe[key] = value
    }
    if (Object.keys(safe).length) out.metadata = safe
  }
  return out
}

export function mergeSafeDomEnrichment(stored: MemoryRecord, incoming: DomGraphPatch): MemoryRecord {
  const safe = protectAuthoritativeGraphPatch(stored, incoming)
  return {
    ...stored,
    ...safe,
    metadata: safe.metadata ? { ...(stored.metadata ?? {}), ...safe.metadata } : stored.metadata,
  }
}

const AUTHORITY_RANK: Record<string, number> = { raw_export: 2, provider_graph: 1 }

/**
 * Preserve stronger graph/provenance authority when a weaker live/provider
 * representation replaces the physical storage for the same logical message.
 * Chunk offsets are intentionally not carried because the new chunker must
 * generate offsets for the new physical content.
 */
export function mergeIncomingWithAuthoritativeGraph(stored: MemoryRecord, incoming: MemoryRecord): MemoryRecord {
  const storedAuthority = typeof stored.metadata?.['graphAuthority'] === 'string' ? String(stored.metadata?.['graphAuthority']) : ''
  const incomingAuthority = typeof incoming.metadata?.['graphAuthority'] === 'string' ? String(incoming.metadata?.['graphAuthority']) : ''
  if ((AUTHORITY_RANK[storedAuthority] ?? 0) <= (AUTHORITY_RANK[incomingAuthority] ?? 0)) return incoming

  const metadata: Record<string, unknown> = { ...(stored.metadata ?? {}), ...(incoming.metadata ?? {}) }
  delete metadata['chunkStartUtf16']
  delete metadata['chunkLengthUtf16']
  // Graph/provenance identity follows the stronger stored source.
  for (const key of GRAPH_METADATA_FIELDS) {
    if (stored.metadata && key in stored.metadata) metadata[key] = stored.metadata[key]
    else delete metadata[key]
  }
  metadata['graphAuthority'] = storedAuthority
  if (stored.metadata?.['recoveryArchive'] === true) metadata['recoveryArchive'] = true

  return {
    ...incoming,
    turnIndex: stored.turnIndex,
    roundIndex: stored.roundIndex,
    branchIndex: stored.branchIndex,
    branchId: stored.branchId,
    pathId: stored.pathId,
    parentMessageId: stored.parentMessageId,
    originalMessageId: stored.originalMessageId ?? incoming.originalMessageId,
    metadata,
  }
}

