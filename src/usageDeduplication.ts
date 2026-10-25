export type DeduplicableUsageRecord = {
  requestId: string;
  sourceLog: string;
  timestamp: string;
  model: string;
  requestType: string;
  turnId?: string;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  cacheWriteTokens: number | null;
  aiCredits: number | null;
  costUsd: number | null;
  chatId?: string;
  conversationTitle?: string;
};

function sourceKind(sourceLog: string): string {
  if (sourceLog.startsWith('agent-host/')) return 'agentHost';
  if (sourceLog.startsWith('copilot-debug/')) return 'debugLogs';
  return 'outputLog';
}

function tokenUsageMatches(left: DeduplicableUsageRecord, right: DeduplicableUsageRecord): boolean {
  const tokenFields: (keyof Pick<DeduplicableUsageRecord, 'promptTokens' | 'outputTokens' | 'cacheTokens' | 'cacheWriteTokens'>)[] = [
    'promptTokens', 'outputTokens', 'cacheTokens', 'cacheWriteTokens'
  ];
  if (!tokenFields.some(field => (left[field] !== null && left[field] !== undefined) || (right[field] !== null && right[field] !== undefined))) return false;
  if (!tokenFields.every(field => (left[field] ?? null) === (right[field] ?? null))) return false;
  const leftCredits = left.aiCredits ?? null;
  const rightCredits = right.aiCredits ?? null;
  return leftCredits === null || rightCredits === null || leftCredits === rightCredits;
}

function areCrossSourceDuplicates(left: DeduplicableUsageRecord, right: DeduplicableUsageRecord): boolean {
  if (!left.turnId || left.turnId !== right.turnId || left.requestType !== 'chat' || right.requestType !== 'chat') return false;
  if (sourceKind(left.sourceLog) === sourceKind(right.sourceLog) || left.model.toLowerCase() !== right.model.toLowerCase()) return false;
  if (!tokenUsageMatches(left, right)) return false;
  const leftTimestamp = Date.parse(left.timestamp);
  const rightTimestamp = Date.parse(right.timestamp);
  return Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp) && Math.abs(leftTimestamp - rightTimestamp) <= 1000;
}

function completeness(record: DeduplicableUsageRecord): number {
  return Number(typeof record.aiCredits === 'number') * 8
    + Number(typeof record.costUsd === 'number') * 4
    + Number(typeof record.promptTokens === 'number')
    + Number(typeof record.outputTokens === 'number')
    + Number(typeof record.cacheTokens === 'number')
    + Number(typeof record.cacheWriteTokens === 'number')
    + Number(Boolean(record.chatId)) * 2
    + Number(Boolean(record.conversationTitle));
}

export function deduplicateUsageRecords<T extends DeduplicableUsageRecord>(records: readonly T[]): T[] {
  const result: T[] = [];
  const indexesByRequestId = new Map<string, number>();

  for (const record of records) {
    const exactIndex = indexesByRequestId.get(record.requestId);
    if (exactIndex !== undefined) {
      if (completeness(record) > completeness(result[exactIndex])) result[exactIndex] = record;
      continue;
    }

    let duplicateIndex: number | undefined;
    for (let index = result.length - 1; index >= 0; index--) {
      if (areCrossSourceDuplicates(result[index], record)) {
        duplicateIndex = index;
        break;
      }
    }

    if (duplicateIndex === undefined) {
      indexesByRequestId.set(record.requestId, result.length);
      result.push(record);
      continue;
    }

    if (completeness(record) > completeness(result[duplicateIndex])) result[duplicateIndex] = record;
    indexesByRequestId.set(record.requestId, duplicateIndex);
  }

  return result.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
