import type { MemoryRecord } from './types'
import { expandRecoveryRecord } from './recovery-chunking'

export interface ChatGPTMessage {
  id?: string
  author?: { role?: string; name?: string | null }
  create_time?: number | string | null
  update_time?: number | string | null
  status?: string
  end_turn?: boolean | null
  recipient?: string | null
  content?: { content_type?: string; parts?: unknown[]; text?: unknown; [key: string]: unknown }
  metadata?: Record<string, unknown> | null
}
export interface ChatGPTMappingNode {
  id?: string
  message?: ChatGPTMessage | null
  parent?: string | null
  children?: string[]
}
export interface ChatGPTConversationDetail {
  id?: string
  conversation_id?: string
  title?: string | null
  create_time?: number | string | null
  update_time?: number | string | null
  current_node?: string | null
  mapping?: Record<string, ChatGPTMappingNode>
}

export interface ProjectorOptions {
  sourceUrl?: string
  source?: string
  importedAt?: number | string
  recoveryArchive?: boolean
  graphAuthority?: 'raw_export' | 'provider_graph'
  conversationIdOverride?: string
  /** Recovery archive import expands into non-overlapping <=500-unit records.
   *  PR #6 live-history sync should set false and let its persistence layer chunk. */
  expandChunks?: boolean
}

interface Candidate {
  nodeId: string
  originalMessageId: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  model?: string
  rawDepth: number
  roundIndex: number
  pathKey: string
  onCurrentPath: boolean
  kind: 'user' | 'durable' | 'progress'
  rawParent?: string | null
}

const FINISHED = new Set(['finished_successfully', 'finished', 'complete'])
const NON_DURABLE_CHANNELS = new Set(['analysis', 'commentary', 'tool'])

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeImportedAt(value: number | string | undefined): number {
  return toMs(value) ?? Date.now()
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') { if (value.trim()) out.push(value); return }
  if (Array.isArray(value)) { for (const item of value) collectText(item, out); return }
  if (!value || typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  if (typeof obj.text === 'string') { if (obj.text.trim()) out.push(obj.text); return }
  if (typeof obj.content === 'string') { if (obj.content.trim()) out.push(obj.content); return }
  if (Array.isArray(obj.content)) collectText(obj.content, out)
  if (Array.isArray(obj.parts)) collectText(obj.parts, out)
}

export interface SourceReferenceMetadata {
  kind: 'citation' | 'content_reference'
  citationFormatType?: string
  referenceType?: string
  matchedText?: string
  urls?: string[]
  items?: Array<{ title?: string; url?: string; attribution?: string; publishedAt?: number | string | null }>
  file?: { name?: string; id?: string; source?: string; libraryFileId?: string; lineRange?: number[]; sourceUrl?: string }
}

function sourceReferences(msg: ChatGPTMessage | null | undefined): SourceReferenceMetadata[] {
  const md = msg?.metadata ?? {}
  const out: SourceReferenceMetadata[] = []
  const citations = md['citations']
  if (Array.isArray(citations)) {
    for (const value of citations.slice(0, 64)) {
      if (!value || typeof value !== 'object') continue
      const c = value as Record<string, unknown>
      const meta = c['metadata'] && typeof c['metadata'] === 'object' ? c['metadata'] as Record<string, unknown> : {}
      const extra = meta['extra'] && typeof meta['extra'] === 'object' ? meta['extra'] as Record<string, unknown> : {}
      const file: SourceReferenceMetadata['file'] = {}
      if (typeof meta['name'] === 'string') file.name = meta['name']
      if (typeof meta['id'] === 'string') file.id = meta['id']
      if (typeof meta['source'] === 'string') file.source = meta['source']
      if (typeof extra['library_file_id'] === 'string') file.libraryFileId = extra['library_file_id']
      if (Array.isArray(extra['line_range'])) file.lineRange = extra['line_range'].filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).slice(0, 2)
      if (typeof extra['source_url'] === 'string') file.sourceUrl = extra['source_url']
      const ref: SourceReferenceMetadata = { kind: 'citation' }
      if (typeof c['citation_format_type'] === 'string') ref.citationFormatType = c['citation_format_type']
      if (Object.keys(file).length > 0) ref.file = file
      out.push(ref)
    }
  }
  const contentRefs = md['content_references']
  if (Array.isArray(contentRefs)) {
    for (const value of contentRefs.slice(0, 64)) {
      if (!value || typeof value !== 'object') continue
      const c = value as Record<string, unknown>
      const urls = Array.isArray(c['safe_urls'])
        ? [...new Set(c['safe_urls'].filter((x): x is string => typeof x === 'string' && !!x))].slice(0, 6)
        : []
      const items: NonNullable<SourceReferenceMetadata['items']> = []
      if (Array.isArray(c['items'])) {
        for (const rawItem of c['items'].slice(0, 6)) {
          if (!rawItem || typeof rawItem !== 'object') continue
          const item = rawItem as Record<string, unknown>
          const compact: NonNullable<SourceReferenceMetadata['items']>[number] = {}
          if (typeof item['title'] === 'string') compact.title = item['title']
          if (typeof item['url'] === 'string') compact.url = item['url']
          if (typeof item['attribution'] === 'string') compact.attribution = item['attribution']
          if (typeof item['pub_date'] === 'number' || typeof item['pub_date'] === 'string' || item['pub_date'] === null) compact.publishedAt = item['pub_date'] as number | string | null
          if (Object.keys(compact).length > 0) items.push(compact)
        }
      }
      const ref: SourceReferenceMetadata = { kind: 'content_reference' }
      if (typeof c['type'] === 'string') ref.referenceType = c['type']
      if (typeof c['matched_text'] === 'string') ref.matchedText = c['matched_text']
      if (urls.length > 0) ref.urls = urls
      if (items.length > 0) ref.items = items
      if (ref.referenceType || ref.matchedText || ref.urls || ref.items) out.push(ref)
    }
  }
  return out
}

export interface SourceAttachmentMetadata {
  id?: string
  name?: string
  mimeType?: string
  size?: number
  libraryFileId?: string
}

function sourceAttachments(msg: ChatGPTMessage | null | undefined): SourceAttachmentMetadata[] {
  const raw = msg?.metadata?.['attachments']
  if (!Array.isArray(raw)) return []
  const out: SourceAttachmentMetadata[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const a = value as Record<string, unknown>
    const item: SourceAttachmentMetadata = {}
    if (typeof a['id'] === 'string' && a['id']) item.id = a['id']
    if (typeof a['name'] === 'string' && a['name']) item.name = a['name']
    if (typeof a['mime_type'] === 'string' && a['mime_type']) item.mimeType = a['mime_type']
    else if (typeof a['mimeType'] === 'string' && a['mimeType']) item.mimeType = a['mimeType']
    if (typeof a['size'] === 'number' && Number.isFinite(a['size'])) item.size = a['size']
    if (typeof a['library_file_id'] === 'string' && a['library_file_id']) item.libraryFileId = a['library_file_id']
    else if (typeof a['libraryFileId'] === 'string' && a['libraryFileId']) item.libraryFileId = a['libraryFileId']
    if (Object.keys(item).length > 0) out.push(item)
  }
  return out
}

function extractedMessageText(msg: ChatGPTMessage | null | undefined): string {
  const type = msg?.content?.content_type
  // Preserve the user-visible content classes that Threadline already treats
  // as conversation text. Do not broadly ingest tether/tool payloads here.
  if (type !== 'text' && type !== 'multimodal_text' && type !== 'code') return ''
  const out: string[] = []
  collectText(msg?.content?.parts ?? [], out)
  if (out.length === 0 && msg?.content?.text !== undefined) collectText(msg.content.text, out)
  return out.join('\n').trim()
}

function messageText(msg: ChatGPTMessage | null | undefined): string {
  const text = extractedMessageText(msg)
  if (text) return text
  const attachments = sourceAttachments(msg)
  if (attachments.length === 0) return ''
  return attachments.map(a => `[Attachment: ${a.name ?? a.id ?? a.mimeType ?? 'file'}]`).join('\n')
}

function isFinished(status: unknown): boolean { return status == null || FINISHED.has(String(status)) }

function assistantKind(msg: ChatGPTMessage, content: string): 'durable' | 'progress' | undefined {
  if (!content || !isFinished(msg.status)) return undefined
  const metadata = msg.metadata ?? {}
  const channel = typeof metadata['channel'] === 'string' ? String(metadata['channel']) : undefined
  const messageType = typeof metadata['message_type'] === 'string' ? String(metadata['message_type']) : undefined
  if (msg.recipient && msg.recipient !== 'all') return undefined
  if (msg.end_turn === false) {
    if (channel === 'commentary' || channel === 'analysis' || channel == null) return 'progress'
    return undefined
  }
  if (channel === 'final' || msg.end_turn === true) return 'durable'
  if (channel && NON_DURABLE_CHANNELS.has(channel)) return 'progress'
  if (messageType === 'next') return 'durable'
  if (!channel && isFinished(msg.status)) return 'durable'
  return 'progress'
}

function selectedPath(mapping: Record<string, ChatGPTMappingNode>, currentNode?: string | null): Set<string> {
  const out = new Set<string>()

  // Prefer the provider's explicit current_node whenever it is valid.
  let cursor = currentNode && mapping[currentNode] ? currentNode : undefined

  // Some exports/fixtures omit current_node even though the parent graph is
  // perfectly usable. In that case infer one deterministic main leaf from the
  // parent relation itself (children arrays are not reliable enough to use as
  // authority). Deepest leaf wins, then latest message timestamp, then id.
  if (!cursor) {
    const parentIds = new Set<string>()
    for (const node of Object.values(mapping)) {
      if (node?.parent && mapping[node.parent]) parentIds.add(node.parent)
    }
    const depthOf = depthComputer(mapping)
    const leaves = Object.keys(mapping).filter((id) => !parentIds.has(id))
    const pool = leaves.length > 0 ? leaves : Object.keys(mapping)
    pool.sort((a, b) => {
      const depth = depthOf(b) - depthOf(a)
      if (depth) return depth
      const aTime = toMs(mapping[a]?.message?.create_time) ?? 0
      const bTime = toMs(mapping[b]?.message?.create_time) ?? 0
      if (aTime !== bTime) return bTime - aTime
      return a.localeCompare(b)
    })
    cursor = pool[0]
  }

  let guard = 0
  while (cursor && mapping[cursor] && guard++ <= Object.keys(mapping).length + 2) {
    if (out.has(cursor)) break
    out.add(cursor)
    cursor = mapping[cursor].parent ?? undefined
  }
  return out
}

function depthComputer(mapping: Record<string, ChatGPTMappingNode>) {
  const memo = new Map<string, number>()
  const visit = (id: string, trail = new Set<string>()): number => {
    const cached = memo.get(id); if (cached !== undefined) return cached
    if (trail.has(id)) return 0
    trail.add(id)
    const parent = mapping[id]?.parent
    const d = parent && mapping[parent] ? visit(parent, trail) + 1 : 0
    trail.delete(id); memo.set(id, d); return d
  }
  return visit
}

function ancestry(mapping: Record<string, ChatGPTMappingNode>, nodeId: string): string[] {
  const out: string[] = []
  let cursor: string | undefined = nodeId
  const seen = new Set<string>()
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor); out.push(cursor); cursor = mapping[cursor].parent ?? undefined
  }
  return out.reverse()
}

function visibleUser(mapping: Record<string, ChatGPTMappingNode>, id: string): boolean {
  const msg = mapping[id]?.message
  return msg?.author?.role === 'user' && !!messageText(msg)
}

function roundFor(mapping: Record<string, ChatGPTMappingNode>, nodeId: string, role: 'user' | 'assistant'): number {
  const chain = ancestry(mapping, nodeId)
  const userCount = chain.reduce((n, id) => n + (visibleUser(mapping, id) ? 1 : 0), 0)
  if (role === 'user') return Math.max(0, userCount - 1)
  return Math.max(0, userCount - 1)
}

function pathKeyFor(mapping: Record<string, ChatGPTMappingNode>, selected: Set<string>, nodeId: string): string {
  if (selected.has(nodeId)) return 'main'
  const chain = ancestry(mapping, nodeId)
  const choices: string[] = []
  for (let i = 1; i < chain.length; i += 1) {
    const parent = chain[i - 1], child = chain[i]
    const children = (mapping[parent]?.children ?? []).filter(id => !!mapping[id])
    if (children.length <= 1) continue
    const selectedChild = children.find(id => selected.has(id) && mapping[id]?.parent === parent)
    if (child !== selectedChild) choices.push(child)
  }
  if (choices.length === 0) {
    const firstOff = chain.find(id => !selected.has(id)) ?? nodeId
    choices.push(firstOff)
  }
  return `side:${choices.join('>')}`
}

function stableSidePathOrder(candidates: Candidate[]): Map<string, number> {
  const earliest = new Map<string, { timestamp: number; depth: number; key: string }>()
  for (const c of candidates) {
    if (c.pathKey === 'main') continue
    const prev = earliest.get(c.pathKey)
    const val = { timestamp: c.timestamp, depth: c.rawDepth, key: c.pathKey }
    if (!prev || val.timestamp < prev.timestamp || (val.timestamp === prev.timestamp && val.depth < prev.depth)) earliest.set(c.pathKey, val)
  }
  const paths = [...earliest.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp || a[1].depth - b[1].depth || a[0].localeCompare(b[0]))
  return new Map(paths.map(([key], i) => [key, i + 1]))
}

function nearestLogicalAncestor(mapping: Record<string, ChatGPTMappingNode>, nodeId: string, logicalNodeIds: Set<string>, originalByNode: Map<string, string>): string | undefined {
  let cursor = mapping[nodeId]?.parent ?? undefined
  const seen = new Set<string>()
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor)
    if (logicalNodeIds.has(cursor)) return originalByNode.get(cursor) ?? mapping[cursor]?.message?.id ?? cursor
    cursor = mapping[cursor]?.parent ?? undefined
  }
  return undefined
}

function chooseLogicalCandidates(candidates: Candidate[]): Candidate[] {
  const users = candidates.filter(c => c.kind === 'user')
  const assistants = candidates.filter(c => c.role === 'assistant')
  const group = new Map<string, Candidate[]>()
  for (const c of assistants) {
    const key = `${c.pathKey}\u0000${c.roundIndex}`
    const arr = group.get(key) ?? []; arr.push(c); group.set(key, arr)
  }
  const chosen: Candidate[] = [...users]
  for (const arr of group.values()) {
    const durable = arr.filter(c => c.kind === 'durable')
    const pool = durable.length ? durable : arr.filter(c => c.kind === 'progress')
    if (!pool.length) continue
    pool.sort((a, b) => a.rawDepth - b.rawDepth || a.timestamp - b.timestamp || a.nodeId.localeCompare(b.nodeId))
    chosen.push(pool[pool.length - 1])
  }
  return chosen
}

export function projectChatGPTConversation(conv: ChatGPTConversationDetail, options: ProjectorOptions = {}): MemoryRecord[] {
  const mapping = conv.mapping
  const conversationId = options.conversationIdOverride?.trim() || conv.conversation_id?.trim() || conv.id?.trim()
  if (!mapping || !conversationId) return []
  const sessionId = `openai:${conversationId}`
  const selected = selectedPath(mapping, conv.current_node)
  const depthOf = depthComputer(mapping)
  const importedAt = normalizeImportedAt(options.importedAt)
  const conversationFallback = toMs(conv.create_time) ?? importedAt
  const source = options.source ?? (options.recoveryArchive === false ? 'chatgpt-api' : 'chatgpt-export')
  const graphAuthority = options.graphAuthority ?? (options.recoveryArchive === false ? 'provider_graph' : 'raw_export')
  const recoveryArchive = options.recoveryArchive ?? true
  const title = typeof conv.title === 'string' && conv.title.trim() ? conv.title.trim() : undefined
  const candidates: Candidate[] = []

  for (const [nodeId, node] of Object.entries(mapping)) {
    const msg = node?.message
    const role = msg?.author?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = messageText(msg)
    if (!content) continue
    if (role === 'user' && !isFinished(msg?.status)) continue
    const kind = role === 'user' ? 'user' : assistantKind(msg!, content)
    if (!kind) continue
    const originalMessageId = typeof msg?.id === 'string' && msg.id.trim() ? msg.id.trim() : (node.id || nodeId)
    candidates.push({
      nodeId,
      originalMessageId,
      role,
      content,
      timestamp: toMs(msg?.create_time) ?? conversationFallback,
      model: typeof msg?.metadata?.['model_slug'] === 'string' ? String(msg.metadata['model_slug']) : undefined,
      rawDepth: depthOf(nodeId),
      roundIndex: roundFor(mapping, nodeId, role),
      pathKey: pathKeyFor(mapping, selected, nodeId),
      onCurrentPath: selected.has(nodeId),
      kind,
      rawParent: node.parent,
    })
  }

  const logical = chooseLogicalCandidates(candidates)
  const branchByPath = stableSidePathOrder(logical)
  const logicalNodeIds = new Set(logical.map(c => c.nodeId))
  const originalByNode = new Map(logical.map(c => [c.nodeId, c.originalMessageId]))
  logical.sort((a, b) => a.timestamp - b.timestamp || a.rawDepth - b.rawDepth || a.nodeId.localeCompare(b.nodeId))

  const records: MemoryRecord[] = logical.map(c => {
    const branchIndex = c.pathKey === 'main' ? 0 : (branchByPath.get(c.pathKey) ?? 1)
    const branchId = `${sessionId}:r${c.roundIndex}:b${branchIndex}`
    const pathId = c.pathKey === 'main' ? `${sessionId}:main` : `${sessionId}:${c.pathKey}`
    const parentMessageId = nearestLogicalAncestor(mapping, c.nodeId, logicalNodeIds, originalByNode)
    const turnIndex = c.roundIndex * 2 + (c.role === 'user' ? 1 : 2)
    const outcome = c.kind === 'progress' ? 'interrupted' : 'durable'
    const sourceMessage = mapping[c.nodeId]?.message
    const attachments = sourceAttachments(sourceMessage)
    const syntheticAttachmentContent = attachments.length > 0 && !extractedMessageText(sourceMessage)
    const references = sourceReferences(sourceMessage)
    const metadata: Record<string, unknown> = {
      recoveryArchive,
      graphAuthority,
      source,
      ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
      ...(title ? { conversationTitle: title } : {}),
      sourceNodeId: c.nodeId,
      sourceParentNodeId: c.rawParent ?? null,
      sourceConversationId: conversationId,
      sourceCurrentNodeId: conv.current_node ?? null,
      onCurrentPath: c.onCurrentPath,
      branchStatus: c.onCurrentPath ? 'selected' : 'side',
      outcome,
      importedAt,
      turnIndex,
      roundIndex: c.roundIndex,
      branchIndex,
      branchId,
      pathId,
      ...(attachments.length > 0 ? { sourceAttachments: attachments } : {}),
      ...(syntheticAttachmentContent ? { syntheticContent: 'attachment_placeholder' } : {}),
      ...(references.length > 0 ? { sourceReferences: references } : {}),
    }
    return {
      id: c.originalMessageId,
      role: c.role,
      content: c.content,
      provider: 'openai',
      sessionId,
      parentMessageId,
      model: c.model,
      originalMessageId: c.originalMessageId,
      source,
      sourceUrl: options.sourceUrl,
      conversationTitle: title,
      timestamp: c.timestamp,
      createdAt: recoveryArchive ? importedAt : c.timestamp,
      turnIndex,
      roundIndex: c.roundIndex,
      branchIndex,
      branchId,
      pathId,
      isPartial: outcome === 'interrupted',
      isDeleted: false,
      isSuperseded: false,
      metadata,
    }
  })

  const expandChunks = options.expandChunks ?? recoveryArchive
  return expandChunks ? records.flatMap(expandRecoveryRecord) : records
}
