import type { SerializableMemoryRecord } from './types'
import type { ImportMessage } from './import-batching'
import { DEFAULT_IMPORT_MESSAGE_BUDGET_BYTES, serializedImportMessageBytes } from './import-batching'

const encoder = new TextEncoder()
const utf8Bytes = (text: string): number => encoder.encode(text).byteLength

const EMPTY_INTERMEDIATE_BYTES = utf8Bytes(JSON.stringify({ type: 'IMPORT_MEMORIES', payload: { records: [], finalize: false } }))
const EMPTY_FINAL_BYTES = utf8Bytes(JSON.stringify({ type: 'IMPORT_MEMORIES', payload: { records: [], finalize: true } }))

export class StreamingImportBatchBuilder {
  private records: SerializableMemoryRecord[] = []
  private serializedRecordBytes = 0
  constructor(readonly maxMessageBytes = DEFAULT_IMPORT_MESSAGE_BUDGET_BYTES) {}

  push(record: SerializableMemoryRecord): ImportMessage[] {
    const recordBytes = utf8Bytes(JSON.stringify(record))
    const comma = this.records.length > 0 ? 1 : 0
    const candidate = EMPTY_INTERMEDIATE_BYTES + this.serializedRecordBytes + comma + recordBytes
    if (candidate <= this.maxMessageBytes) {
      this.records.push(record)
      this.serializedRecordBytes += comma + recordBytes
      return []
    }
    if (this.records.length === 0) throw new Error('Single recovery record exceeds runtime-message budget')
    const flushed: ImportMessage = { type: 'IMPORT_MEMORIES', payload: { records: this.records, finalize: false } }
    if (serializedImportMessageBytes(flushed) > this.maxMessageBytes) throw new Error('Intermediate recovery batch exceeded exact runtime-message budget')
    this.records = []
    this.serializedRecordBytes = 0
    const singleCandidate = EMPTY_INTERMEDIATE_BYTES + recordBytes
    if (singleCandidate > this.maxMessageBytes) throw new Error('Single recovery record exceeds runtime-message budget')
    this.records.push(record)
    this.serializedRecordBytes = recordBytes
    return [flushed]
  }

  finish(): ImportMessage {
    const message: ImportMessage = { type: 'IMPORT_MEMORIES', payload: { records: this.records, finalize: true } }
    if (serializedImportMessageBytes(message) > this.maxMessageBytes) {
      // This is only possible when the final envelope is a few bytes larger than
      // the intermediate envelope. Flush current records as intermediate and let
      // the caller send an empty finalize-only message next.
      throw new Error('Final recovery batch exceeds runtime-message budget; flush before finish')
    }
    this.records = []
    this.serializedRecordBytes = 0
    return message
  }

  drainForFinish(): ImportMessage[] {
    const out: ImportMessage[] = []
    if (this.records.length > 0) {
      const final: ImportMessage = { type: 'IMPORT_MEMORIES', payload: { records: this.records, finalize: true } }
      if (serializedImportMessageBytes(final) <= this.maxMessageBytes) {
        this.records = []
        this.serializedRecordBytes = 0
        return [final]
      }
      const intermediate: ImportMessage = { type: 'IMPORT_MEMORIES', payload: { records: this.records, finalize: false } }
      if (serializedImportMessageBytes(intermediate) > this.maxMessageBytes) throw new Error('Recovery batch exceeds runtime-message budget')
      out.push(intermediate)
      this.records = []
      this.serializedRecordBytes = 0
    }
    const finalOnly: ImportMessage = { type: 'IMPORT_MEMORIES', payload: { records: [], finalize: true } }
    if (utf8Bytes(JSON.stringify(finalOnly)) !== EMPTY_FINAL_BYTES || serializedImportMessageBytes(finalOnly) > this.maxMessageBytes) {
      throw new Error('Finalize-only recovery message exceeds runtime-message budget')
    }
    out.push(finalOnly)
    return out
  }
}
