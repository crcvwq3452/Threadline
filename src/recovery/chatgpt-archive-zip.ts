/**
 * Thin ZIP transport for the tested archive-import runner.
 * Requires `@zip.js/zip.js` (2.16.0 reviewed 2026-09-21).
 */
import { BlobReader, BlobWriter, TextWriter, ZipReader } from '@zip.js/zip.js'
import {
  importChatGPTArchiveFromScanner,
  type ArchiveImportResult,
  type ArchiveImportRunnerOptions,
  type ImportBatchResponse,
  type JsonEntryScanner,
} from './archive-import-runner'
import type { ImportMessage } from './import-batching'

async function scanZipBlob(
  blob: Blob,
  visit: (entryPath: string, text: string) => Promise<void>,
  prefix: string,
  depth: number,
  maxDepth: number,
): Promise<void> {
  const reader = new ZipReader(new BlobReader(blob))
  try {
    const entries = await reader.getEntries()
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (entry.directory) continue
      const stablePath = `${prefix}${entry.filename}[zip-entry:${index}]`
      const lower = entry.filename.toLocaleLowerCase()
      if (lower.endsWith('.json')) {
        const text = await entry.getData?.(new TextWriter())
        if (typeof text !== 'string') throw new Error(`Could not decode JSON entry: ${stablePath}`)
        await visit(stablePath, text)
      } else if (lower.endsWith('.zip') && depth < maxDepth) {
        const nested = await entry.getData?.(new BlobWriter('application/zip'))
        if (!(nested instanceof Blob)) throw new Error(`Could not decode nested ZIP entry: ${stablePath}`)
        await scanZipBlob(nested, visit, `${stablePath}!/`, depth + 1, maxDepth)
      }
    }
  } finally {
    await reader.close()
  }
}

export interface ZipArchiveImportOptions extends ArchiveImportRunnerOptions { maxNestedZipDepth?: number }

export async function importChatGPTArchiveZip(
  archive: File | Blob,
  sendBatch: (message: ImportMessage) => Promise<ImportBatchResponse>,
  options: ZipArchiveImportOptions = {},
): Promise<ArchiveImportResult> {
  const maxDepth = options.maxNestedZipDepth ?? 2
  const scan: JsonEntryScanner = visit => scanZipBlob(archive, visit, '', 0, maxDepth)
  return importChatGPTArchiveFromScanner(scan, sendBatch, options)
}
