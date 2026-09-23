import type { MemoryRecord } from './types'

export interface CurrentAuthorityRule {
  id: string
  text: string
  status?: 'active' | 'retired'
  scope?: 'global' | `session:${string}`
  updatedAt?: number
  sourceRef?: string
}

export interface RecallEvidence extends Pick<MemoryRecord,
  'id' | 'role' | 'content' | 'sessionId' | 'timestamp' | 'roundIndex' | 'branchIndex' | 'conversationTitle' | 'originalMessageId' | 'metadata'
> {}

export function inferSingleEvidenceSession(evidence: RecallEvidence[]): string | undefined {
  const sessions = [...new Set(evidence.map(item => item.sessionId).filter(Boolean))]
  return sessions.length === 1 ? sessions[0] : undefined
}

export function activeAuthorityRules(rules: CurrentAuthorityRule[], sessionId?: string): CurrentAuthorityRule[] {
  return rules
    .filter(r => (r.status ?? 'active') === 'active')
    .filter(r => !r.scope || r.scope === 'global' || (sessionId && r.scope === `session:${sessionId}`))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
}

function evidenceLabel(e: RecallEvidence): string {
  const date = Number.isFinite(e.timestamp) ? new Date(e.timestamp).toISOString() : 'unknown-date'
  const branch = e.metadata?.['branchStatus'] === 'side' || (e.branchIndex ?? 0) > 0 ? `side branch ${e.branchIndex ?? '?'}` : 'selected path'
  const outcome = e.metadata?.['outcome'] === 'interrupted' ? 'interrupted progress' : 'durable'
  const node = String(e.metadata?.['sourceNodeId'] ?? e.originalMessageId ?? e.id)
  const title = e.conversationTitle ? `“${e.conversationTitle}”` : e.sessionId
  const attachments = Array.isArray(e.metadata?.['sourceAttachments']) ? e.metadata?.['sourceAttachments'] as Array<Record<string, unknown>> : []
  const refs = Array.isArray(e.metadata?.['sourceReferences']) ? e.metadata?.['sourceReferences'] as unknown[] : []
  const attachmentNames = attachments.map(a => typeof a['name'] === 'string' ? a['name'] : undefined).filter(Boolean).slice(0, 4)
  const provenance = [
    attachments.length ? `attachments ${attachments.length}${attachmentNames.length ? ` (${attachmentNames.join(', ')})` : ''}` : '',
    refs.length ? `source refs ${refs.length}` : '',
  ].filter(Boolean).join(' | ')
  return `${date} | ${title} | ${e.role} | round ${e.roundIndex ?? '?'} | ${branch} | ${outcome} | source ${node}${provenance ? ` | ${provenance}` : ''}`
}

export function formatRecoveryRagPrompt(
  query: string,
  evidence: RecallEvidence[],
  rules: CurrentAuthorityRule[],
  sessionId?: string,
): string {
  const active = activeAuthorityRules(rules, sessionId)
  const authority = active.length
    ? active.map(r => `- ${r.text}${r.sourceRef ? ` [${r.sourceRef}]` : ''}`).join('\n')
    : '- No explicit current-authority rules matched this session.'
  const history = evidence.length
    ? evidence.map((e, i) => `[H${i + 1}] ${evidenceLabel(e)}\n${e.content}`).join('\n\n')
    : '(No historical evidence selected.)'
  return [
    'CURRENT AUTHORITY',
    'Treat these as current standing instructions/decisions when they conflict with older historical evidence:',
    authority,
    '',
    'RETRIEVED HISTORICAL EVIDENCE',
    'Historical evidence may be superseded, interrupted, or from an inactive branch. Use the provenance labels below rather than assuming every item is current truth.',
    history,
    '',
    'CURRENT USER QUERY',
    query,
  ].join('\n')
}
