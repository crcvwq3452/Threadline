/**
 * Drop-in replacement for PR #6 src/utils/chatgpt-history.ts.
 * Requires the recovery projector under src/recovery/chatgpt-dag-projector.ts.
 *
 * Important: live-history sync returns LOGICAL records. PR #6's persistence
 * layer remains responsible for live chunking/upsert/embedding.
 */
import type { MemoryRecord } from '../types/memory'
import {
  projectChatGPTConversation,
  type ChatGPTConversationDetail,
  type ChatGPTMappingNode,
} from '../recovery/chatgpt-dag-projector'

export type { ChatGPTConversationDetail, ChatGPTMappingNode }

export function parseChatGPTConversationDetail(
  conv: ChatGPTConversationDetail,
  url: string,
  conversationIdOverride?: string,
): MemoryRecord[] {
  return projectChatGPTConversation(conv, {
    sourceUrl: url,
    source: 'chatgpt-api',
    recoveryArchive: false,
    graphAuthority: 'provider_graph',
    conversationIdOverride,
    expandChunks: false,
  }) as MemoryRecord[]
}
