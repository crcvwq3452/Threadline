import type { SearchMemoriesResponse } from '../types/messages'
import {
  formatRecoveryRagPrompt,
  type CurrentAuthorityRule,
  type RecallEvidence,
  inferSingleEvidenceSession,
} from '../recovery/authority-rag'

export const CURRENT_AUTHORITY_STORAGE_KEY = 'threadlineCurrentAuthorityRules'

export async function loadCurrentAuthorityRules(): Promise<CurrentAuthorityRule[]> {
  try {
    const stored = await chrome.storage.local.get(CURRENT_AUTHORITY_STORAGE_KEY)
    const value = stored?.[CURRENT_AUTHORITY_STORAGE_KEY]
    if (!Array.isArray(value)) return []
    return value.filter((rule): rule is CurrentAuthorityRule =>
      !!rule && typeof rule === 'object' && typeof rule.id === 'string' && typeof rule.text === 'string',
    )
  } catch {
    return []
  }
}

export function formatRAGPrompt(
  query: string,
  results: SearchMemoriesResponse['payload']['results'],
  authorityRules: CurrentAuthorityRule[] = [],
): string {
  return formatRecoveryRagPrompt(
    query,
    results as RecallEvidence[],
    authorityRules,
    inferSingleEvidenceSession(results as RecallEvidence[]),
  )
}
