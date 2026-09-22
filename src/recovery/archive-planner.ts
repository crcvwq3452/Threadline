import { projectChatGPTConversation, type ChatGPTConversationDetail } from './chatgpt-dag-projector'
import { expandRecoveryRecord } from './recovery-chunking'
import { selectSnapshotsLosslessly, type ConversationSnapshot, type SnapshotSelection } from './snapshot-dedup'
import type { MemoryRecord } from './types'

export interface ArchiveConversationLocator {
  sourceKey: string
  entryName: string
  conversationIndex: number
  sourceHash?: string
}

export interface ArchiveSnapshotDescriptor extends ConversationSnapshot {
  rawNodeCount: number
  locator: ArchiveConversationLocator
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function conversationId(conv: ChatGPTConversationDetail): string | undefined {
  const id = conv.conversation_id?.trim() || conv.id?.trim()
  return id || undefined
}

function stableLogicalFingerprint(record: MemoryRecord): string {
  const m = record.metadata ?? {}
  return JSON.stringify({
    role: record.role,
    content: record.content,
    parentMessageId: record.parentMessageId ?? null,
    roundIndex: record.roundIndex ?? null,
    onCurrentPath: m['onCurrentPath'] ?? null,
    outcome: m['outcome'] ?? null,
    sourceAttachments: m['sourceAttachments'] ?? null,
  })
}

export async function sha256Text(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function discoverChatGPTConversations(value: unknown): ChatGPTConversationDetail[] {
  const out: ChatGPTConversationDetail[] = []
  const seen = new Set<object>()
  const visit = (v: unknown, depth: number): void => {
    if (depth > 3 || !v || typeof v !== 'object') return
    const obj = v as Record<string, unknown>
    if (seen.has(obj)) return
    seen.add(obj)
    if (obj.mapping && typeof obj.mapping === 'object' && (typeof obj.id === 'string' || typeof obj.conversation_id === 'string')) {
      out.push(obj as unknown as ChatGPTConversationDetail)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1)
      return
    }
    for (const key of ['conversations', 'items', 'data', 'threads']) {
      if (key in obj) visit(obj[key], depth + 1)
    }
  }
  visit(value, 0)
  return out
}

export async function describeArchiveConversation(
  conv: ChatGPTConversationDetail,
  locator: ArchiveConversationLocator,
): Promise<ArchiveSnapshotDescriptor | undefined> {
  const id = conversationId(conv)
  if (!id || !conv.mapping) return undefined
  const logical = projectChatGPTConversation(conv, {
    recoveryArchive: true,
    graphAuthority: 'raw_export',
    expandChunks: false,
    importedAt: 0,
  })
  const nodes = await Promise.all(logical.map(async record => ({
    id: record.originalMessageId ?? record.id,
    fingerprint: await sha256Text(stableLogicalFingerprint(record)),
  })))
  return {
    conversationId: id,
    sourceKey: locator.sourceKey,
    sourceHash: locator.sourceHash,
    updateTime: toMs(conv.update_time),
    createTime: toMs(conv.create_time),
    rawNodeCount: Object.keys(conv.mapping).length,
    nodes,
    locator,
  }
}

export function planArchiveSnapshots(descriptors: ArchiveSnapshotDescriptor[]): SnapshotSelection[] {
  return selectSnapshotsLosslessly(descriptors)
}

export type SnapshotAction =
  | { kind: 'winner'; conversationId: string; sourceHash?: string }
  | { kind: 'residual'; conversationId: string; nodeIds: Set<string>; reason: string; sourceHash?: string; residualOrdinal: number }
  | { kind: 'suppressed'; conversationId: string; sourceHash?: string }

export function buildSnapshotActionIndex(selections: SnapshotSelection[], descriptors: ArchiveSnapshotDescriptor[] = []): Map<string, SnapshotAction> {
  const out = new Map<string, SnapshotAction>()
  const bySource = new Map(descriptors.map(d => [d.sourceKey, d]))
  for (const selection of selections) {
    out.set(selection.winner.sourceKey, { kind: 'winner', conversationId: selection.conversationId, sourceHash: bySource.get(selection.winner.sourceKey)?.sourceHash ?? selection.winner.sourceHash })
    for (const key of selection.suppressedSourceKeys) out.set(key, { kind: 'suppressed', conversationId: selection.conversationId, sourceHash: bySource.get(key)?.sourceHash })
    selection.residuals.forEach((residual, residualOrdinal) => out.set(residual.sourceKey, {
      kind: 'residual',
      conversationId: selection.conversationId,
      nodeIds: new Set(residual.residualNodeIds),
      reason: residual.reason,
      sourceHash: bySource.get(residual.sourceKey)?.sourceHash,
      residualOrdinal,
    }))
  }
  return out
}

function stableSourceTag(sourceKey: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < sourceKey.length; i += 1) {
    hash ^= sourceKey.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function projectSnapshotAction(
  conv: ChatGPTConversationDetail,
  sourceKey: string,
  action: SnapshotAction,
  importedAt: number | string,
): MemoryRecord[] {
  if (action.kind === 'suppressed') return []
  const logical = projectChatGPTConversation(conv, {
    recoveryArchive: true,
    graphAuthority: 'raw_export',
    expandChunks: false,
    importedAt,
  })
  const selected = action.kind === 'winner'
    ? logical
    : logical.filter(record => action.nodeIds.has(record.originalMessageId ?? record.id))
  const residualIds = action.kind === 'residual'
    ? new Set(selected.map(record => record.originalMessageId ?? record.id))
    : new Set<string>()
  const residualTag = action.kind === 'residual'
    ? (action.sourceHash?.slice(0, 12) || stableSourceTag(sourceKey))
    : undefined
  return selected.flatMap(record => {
    const metadata: Record<string, unknown> = {
      ...(record.metadata ?? {}),
      sourceSnapshotKey: sourceKey,
      ...(action.sourceHash ? { sourceSnapshotHash: action.sourceHash } : {}),
      ...(action.kind === 'residual' ? {
        snapshotResidual: true,
        snapshotResidualReason: action.reason,
        snapshotResidualTag: residualTag,
      } : {}),
    }
    if (action.kind !== 'residual') return expandRecoveryRecord({ ...record, metadata })
    const originalId = record.originalMessageId ?? record.id
    const localId = `${originalId}:snapshot:${residualTag}`
    const originalParent = record.parentMessageId
    const localParent = originalParent && residualIds.has(originalParent)
      ? `${originalParent}:snapshot:${residualTag}`
      : originalParent
    const residualBranch = 1_000_000 + action.residualOrdinal * 1_000 + (record.branchIndex ?? 0)
    const sessionId = record.sessionId
    return expandRecoveryRecord({
      ...record,
      id: localId,
      originalMessageId: originalId,
      parentMessageId: localParent,
      branchIndex: residualBranch,
      branchId: `${sessionId}:r${record.roundIndex ?? 0}:snapshot:${residualTag}:b${record.branchIndex ?? 0}`,
      pathId: `${sessionId}:snapshot:${residualTag}:${record.pathId ?? 'path'}`,
      metadata: {
        ...metadata,
        sourceOriginalMessageId: originalId,
        sourceOriginalParentMessageId: originalParent ?? null,
        originalBranchIndex: record.branchIndex ?? 0,
      },
    })
  })
}
