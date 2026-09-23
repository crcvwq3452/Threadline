import {
  buildSnapshotActionIndex,
  describeArchiveConversation,
  discoverChatGPTConversations,
  planArchiveSnapshots,
  projectSnapshotAction,
  sha256Text,
  type ArchiveSnapshotDescriptor,
} from './archive-planner'
import { StreamingImportBatchBuilder } from './import-streaming'
import type { ImportMessage } from './import-batching'
import type { SerializableMemoryRecord } from './types'

export type JsonEntryVisitor = (entryPath: string, text: string) => Promise<void>
export type JsonEntryScanner = (visit: JsonEntryVisitor) => Promise<void>

export interface ArchiveImportProgress {
  phase: 'catalog' | 'project' | 'done'
  jsonEntries: number
  conversations: number
  projectedRecords: number
  sentRecords: number
  skippedRecords: number
  batches: number
  invalidJsonEntries: number
  unsupportedJsonEntries: number
  currentEntry?: string
}
export interface ArchiveImportResult extends ArchiveImportProgress {
  phase: 'done'
  winners: number
  residualSnapshots: number
  suppressedSnapshots: number
}
export interface ImportBatchResponse { success: boolean; count: number; skipped?: number; error?: string }
export interface ArchiveImportRunnerOptions {
  maxMessageBytes?: number
  importedAt?: number | string
  onProgress?: (progress: ArchiveImportProgress) => void
}

async function sendChecked(send: (message: ImportMessage) => Promise<ImportBatchResponse>, message: ImportMessage): Promise<ImportBatchResponse> {
  const response = await send(message)
  if (!response.success) throw new Error(response.error ?? 'Threadline archive import batch failed')
  return response
}

export async function importChatGPTArchiveFromScanner(
  scan: JsonEntryScanner,
  sendBatch: (message: ImportMessage) => Promise<ImportBatchResponse>,
  options: ArchiveImportRunnerOptions = {},
): Promise<ArchiveImportResult> {
  const importedAt = options.importedAt ?? Date.now()
  const descriptors: ArchiveSnapshotDescriptor[] = []
  let jsonEntries = 0, conversations = 0, projectedRecords = 0, sentRecords = 0, skippedRecords = 0, batches = 0
  let invalidJsonEntries = 0, unsupportedJsonEntries = 0
  const progress = (phase: ArchiveImportProgress['phase'], currentEntry?: string) => options.onProgress?.({
    phase, jsonEntries, conversations, projectedRecords, sentRecords, skippedRecords, batches, invalidJsonEntries, unsupportedJsonEntries, currentEntry,
  })

  await scan(async (entryPath, text) => {
    jsonEntries += 1
    progress('catalog', entryPath)
    let parsed: unknown
    try { parsed = JSON.parse(text) }
    catch { invalidJsonEntries += 1; return }
    const discovered = discoverChatGPTConversations(parsed)
    if (discovered.length === 0) { unsupportedJsonEntries += 1; return }
    const sourceHash = await sha256Text(text)
    for (let index = 0; index < discovered.length; index += 1) {
      conversations += 1
      const sourceKey = `${entryPath}#conversation:${index}`
      const descriptor = await describeArchiveConversation(discovered[index], {
        sourceKey, entryName: entryPath, conversationIndex: index, sourceHash,
      })
      if (descriptor) descriptors.push(descriptor)
    }
  })

  if (descriptors.length === 0) throw new Error('No supported ChatGPT mapping conversations were found in the selected archive')
  const selections = planArchiveSnapshots(descriptors)
  const actions = buildSnapshotActionIndex(selections, descriptors)
  const batcher = new StreamingImportBatchBuilder(options.maxMessageBytes)

  await scan(async (entryPath, text) => {
    progress('project', entryPath)
    let parsed: unknown
    try { parsed = JSON.parse(text) }
    catch { return }
    const discovered = discoverChatGPTConversations(parsed)
    if (discovered.length === 0) return
    for (let index = 0; index < discovered.length; index += 1) {
      const sourceKey = `${entryPath}#conversation:${index}`
      const action = actions.get(sourceKey)
      if (!action || action.kind === 'suppressed') continue
      const records = projectSnapshotAction(discovered[index], sourceKey, action, importedAt)
      projectedRecords += records.length
      for (const record of records) {
        const serializable: SerializableMemoryRecord = {
          ...record,
          embedding: record.embedding ? Array.from(record.embedding) : undefined,
        }
        for (const message of batcher.push(serializable)) {
          const response = await sendChecked(sendBatch, message)
          sentRecords += response.count; skippedRecords += response.skipped ?? 0; batches += 1
        }
      }
    }
  })

  for (const message of batcher.drainForFinish()) {
    const response = await sendChecked(sendBatch, message)
    sentRecords += response.count; skippedRecords += response.skipped ?? 0; batches += 1
  }

  const result: ArchiveImportResult = {
    phase: 'done', jsonEntries, conversations, projectedRecords, sentRecords, skippedRecords, batches, invalidJsonEntries, unsupportedJsonEntries,
    winners: selections.length,
    residualSnapshots: selections.reduce((n, s) => n + s.residuals.length, 0),
    suppressedSnapshots: selections.reduce((n, s) => n + s.suppressedSourceKeys.length, 0),
  }
  options.onProgress?.(result)
  return result
}
