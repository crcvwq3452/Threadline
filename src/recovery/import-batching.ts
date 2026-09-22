import type { FavoritePrompt, PromptFolder, SerializableMemoryRecord } from './types'

export const DEFAULT_IMPORT_MESSAGE_BUDGET_BYTES = 8 * 1024 * 1024
const encoder = new TextEncoder()
const bytes = (s: string) => encoder.encode(s).byteLength

export interface ImportPayload {
  records: SerializableMemoryRecord[]
  prompts?: FavoritePrompt[]
  folders?: PromptFolder[]
  finalize?: boolean
}
export interface ImportMessage { type: 'IMPORT_MEMORIES'; payload: ImportPayload }

function buildMessage(records: SerializableMemoryRecord[], finalize: boolean, prompts?: FavoritePrompt[], folders?: PromptFolder[]): ImportMessage {
  const payload: ImportPayload = { records, finalize }
  if (finalize && prompts) payload.prompts = prompts
  if (finalize && folders) payload.folders = folders
  return { type: 'IMPORT_MEMORIES', payload }
}

function emptyMessageOverhead(finalize: boolean, prompts?: FavoritePrompt[], folders?: PromptFolder[]): number {
  const marker = '__RECORD_ARRAY_MARKER__'
  const payload: Record<string, unknown> = { records: marker, finalize }
  if (finalize && prompts) payload.prompts = prompts
  if (finalize && folders) payload.folders = folders
  const json = JSON.stringify({ type: 'IMPORT_MEMORIES', payload })
  return bytes(json) - bytes(JSON.stringify(marker)) + 2 // [] replacing marker
}

function recordArrayBytes(serializedByteLengths: number[]): number {
  if (serializedByteLengths.length === 0) return 0
  return serializedByteLengths.reduce((a, b) => a + b, 0) + serializedByteLengths.length - 1
}

export function serializedImportMessageBytes(message: ImportMessage): number {
  return bytes(JSON.stringify(message))
}

export function buildImportBatches(
  records: SerializableMemoryRecord[],
  options: { prompts?: FavoritePrompt[]; folders?: PromptFolder[]; maxMessageBytes?: number } = {},
): ImportMessage[] {
  const max = options.maxMessageBytes ?? DEFAULT_IMPORT_MESSAGE_BUDGET_BYTES
  const serialized = records.map(r => JSON.stringify(r))
  const lengths = serialized.map(bytes)
  const normalOverhead = emptyMessageOverhead(false)
  const finalOverhead = emptyMessageOverhead(true, options.prompts, options.folders)
  if (finalOverhead > max) throw new Error(`Final import metadata alone exceeds message budget (${finalOverhead} > ${max})`)

  // Build the final batch from the tail so prompts/folders are always accounted for.
  let finalStart = records.length
  let finalArrayBytes = 0
  while (finalStart > 0) {
    const nextLen = lengths[finalStart - 1]
    const candidateCount = records.length - (finalStart - 1)
    const candidateArray = finalArrayBytes + nextLen + (candidateCount > 1 ? 1 : 0)
    if (finalOverhead + candidateArray > max) break
    finalStart -= 1
    finalArrayBytes = candidateArray
  }

  const result: ImportMessage[] = []
  let start = 0
  while (start < finalStart) {
    let end = start
    let arr = 0
    while (end < finalStart) {
      const candidateCount = end - start + 1
      const candidate = arr + lengths[end] + (candidateCount > 1 ? 1 : 0)
      if (normalOverhead + candidate > max) break
      arr = candidate
      end += 1
    }
    if (end === start) throw new Error(`Single record exceeds message budget at index ${start}`)
    const msg = buildMessage(records.slice(start, end), false)
    const exact = serializedImportMessageBytes(msg)
    if (exact > max) throw new Error(`Intermediate batch exceeded exact budget: ${exact} > ${max}`)
    result.push(msg)
    start = end
  }

  const finalMsg = buildMessage(records.slice(finalStart), true, options.prompts, options.folders)
  const finalExact = serializedImportMessageBytes(finalMsg)
  if (finalExact > max) throw new Error(`Final batch exceeded exact budget: ${finalExact} > ${max}`)
  result.push(finalMsg)
  return result
}
