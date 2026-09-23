import type { SerializableMemoryRecord } from './types'

export interface ImportPlan {
  newRecords: SerializableMemoryRecord[]
  duplicateCount: number
  shouldFinalize: boolean
}

export function planIdempotentImport(
  incoming: SerializableMemoryRecord[],
  existingIds: ReadonlySet<string>,
  finalize = false,
): ImportPlan {
  const seen = new Set<string>(existingIds)
  const newRecords: SerializableMemoryRecord[] = []
  let duplicateCount = 0
  for (const record of incoming) {
    if (seen.has(record.id)) { duplicateCount += 1; continue }
    seen.add(record.id)
    newRecords.push(record)
  }
  // Deliberately independent of newRecords.length: a retry after persistence but
  // before indexing must still be able to run the missing finalization step.
  return { newRecords, duplicateCount, shouldFinalize: finalize }
}
