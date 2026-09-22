import type { SerializableMemoryRecord } from '../types/memory'
import type { IConversationImporter } from './base'
import { registerImporter } from './base'
import { discoverChatGPTConversations } from '../recovery/archive-planner'
import { projectChatGPTConversation } from '../recovery/chatgpt-dag-projector'

/**
 * Branch-safe ChatGPT JSON importer.
 *
 * Unlike the stock importer, this follows the raw mapping DAG/current_node
 * model and preserves inactive branches/provenance. ZIP imports use the
 * archive runner so duplicate snapshots can be planned losslessly first;
 * direct JSON imports project every discovered conversation in the selected
 * document.
 */
export function parseChatGPTConversations(raw: unknown): SerializableMemoryRecord[] {
  const conversations = discoverChatGPTConversations(raw)
  if (conversations.length === 0) throw new Error('No ChatGPT mapping conversations found')
  const importedAt = Date.now()
  return conversations.flatMap((conv) =>
    projectChatGPTConversation(conv, {
      recoveryArchive: true,
      graphAuthority: 'raw_export',
      expandChunks: true,
      importedAt,
    }).map((record) => ({
      ...record,
      embedding: record.embedding ? Array.from(record.embedding) : undefined,
    })),
  )
}

class ChatGPTConversationImporter implements IConversationImporter {
  readonly id = 'chatgpt'
  readonly displayName = 'ChatGPT (conversations.json)'
  readonly provider = 'openai' as const
  canHandle(raw: unknown): boolean { return discoverChatGPTConversations(raw).length > 0 }
  parse(raw: unknown): SerializableMemoryRecord[] { return parseChatGPTConversations(raw) }
}

registerImporter(new ChatGPTConversationImporter())
