export type MessageRole = 'user' | 'assistant'
export type AIProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'perplexity'

export interface MemoryRecord {
  id: string
  role: MessageRole
  content: string
  provider: AIProvider
  sessionId: string
  parentMessageId?: string
  model?: string
  originalMessageId?: string
  source?: string
  sourceUrl?: string
  conversationTitle?: string
  timestamp: number
  createdAt: number
  turnIndex?: number
  roundIndex?: number
  branchIndex?: number
  branchId?: string
  pathId?: string
  chunkIndex?: number
  parentId?: string
  embedding?: Float32Array
  embeddingModel?: string
  embeddingVersion?: string
  hasEmbedding?: number
  isPartial: boolean
  isDeleted: boolean
  isSuperseded: boolean
  metadata?: Record<string, unknown>
}

export type SerializableMemoryRecord = Omit<MemoryRecord, 'embedding'> & { embedding?: number[] }

export interface FavoritePrompt { id: string; text: string; createdAt: number }
export interface PromptFolder { id: string; name: string; promptIds: string[]; createdAt: number }
