export interface SnapshotNode {
  id: string
  fingerprint: string
}
export interface ConversationSnapshot {
  conversationId: string
  sourceKey: string
  sourceHash?: string
  updateTime?: number
  createTime?: number
  nodes: SnapshotNode[]
  rawNodeCount?: number
}
export interface SnapshotResidual {
  sourceKey: string
  residualNodeIds: string[]
  reason: 'non_nested_unique_nodes' | 'changed_node_content'
}
export interface SnapshotSelection {
  conversationId: string
  winner: ConversationSnapshot
  suppressedSourceKeys: string[]
  residuals: SnapshotResidual[]
}

function winnerCompare(a: ConversationSnapshot, b: ConversationSnapshot): number {
  return (b.updateTime ?? -Infinity) - (a.updateTime ?? -Infinity)
    || (b.rawNodeCount ?? b.nodes.length) - (a.rawNodeCount ?? a.nodes.length)
    || b.nodes.length - a.nodes.length
    || (b.createTime ?? -Infinity) - (a.createTime ?? -Infinity)
    || a.sourceKey.localeCompare(b.sourceKey)
}

export function selectSnapshotsLosslessly(snapshots: ConversationSnapshot[]): SnapshotSelection[] {
  const grouped = new Map<string, ConversationSnapshot[]>()
  for (const snapshot of snapshots) {
    const arr = grouped.get(snapshot.conversationId) ?? []
    arr.push(snapshot); grouped.set(snapshot.conversationId, arr)
  }
  const selections: SnapshotSelection[] = []
  for (const [conversationId, group] of grouped) {
    const sorted = [...group].sort(winnerCompare)
    const winner = sorted[0]
    const winnerById = new Map(winner.nodes.map(n => [n.id, n.fingerprint]))
    const suppressedSourceKeys: string[] = []
    const residuals: SnapshotResidual[] = []
    for (const snapshot of sorted.slice(1)) {
      const unique: string[] = []
      let changed = false
      for (const node of snapshot.nodes) {
        const winnerFingerprint = winnerById.get(node.id)
        if (winnerFingerprint === undefined) unique.push(node.id)
        else if (winnerFingerprint !== node.fingerprint) { unique.push(node.id); changed = true }
      }
      if (unique.length === 0) suppressedSourceKeys.push(snapshot.sourceKey)
      else residuals.push({
        sourceKey: snapshot.sourceKey,
        residualNodeIds: unique,
        reason: changed ? 'changed_node_content' : 'non_nested_unique_nodes',
      })
    }
    selections.push({ conversationId, winner, suppressedSourceKeys, residuals })
  }
  return selections.sort((a, b) => a.conversationId.localeCompare(b.conversationId))
}
