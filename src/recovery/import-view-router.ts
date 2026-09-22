import type { SerializableMemoryRecord } from './types'

export interface ProviderImporterLike {
  id: string
  displayName: string
  canHandle(raw: unknown): boolean
  parse(raw: unknown): SerializableMemoryRecord[]
}

export interface BrowserFileLike {
  name: string
  text(): Promise<string>
}

export interface ImportCounts {
  count: number
  skipped: number
}

export interface ArchiveImportCounts extends ImportCounts {
  batches?: number
  invalidJsonEntries?: number
  unsupportedJsonEntries?: number
}

export function providerImportAccept(importerId: string): string {
  return importerId === 'chatgpt' ? '.json,.zip' : '.json'
}

export function isChatGPTArchiveZip(importerId: string, fileName: string): boolean {
  return importerId === 'chatgpt' && fileName.toLocaleLowerCase().endsWith('.zip')
}

export async function importSelectedProviderFile(
  file: BrowserFileLike,
  importer: ProviderImporterLike,
  handlers: {
    sendRecords: (records: SerializableMemoryRecord[]) => Promise<ImportCounts>
    importChatGPTZip: (file: BrowserFileLike) => Promise<ArchiveImportCounts>
  },
): Promise<ImportCounts & { mode: 'json' | 'zip' }> {
  if (isChatGPTArchiveZip(importer.id, file.name)) {
    const result = await handlers.importChatGPTZip(file)
    return { count: result.count, skipped: result.skipped, mode: 'zip' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(await file.text())
  } catch {
    throw new Error(`Invalid ${importer.displayName} JSON export`)
  }
  if (!importer.canHandle(raw)) throw new Error(`Unsupported ${importer.displayName} export`)
  const records = importer.parse(raw)
  if (records.length === 0) throw new Error(`No importable ${importer.displayName} messages found`)
  const result = await handlers.sendRecords(records)
  return { ...result, mode: 'json' }
}
