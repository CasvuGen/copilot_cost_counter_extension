import { createHash } from 'node:crypto';

export type CopilotDebugSpan = {
  key: string;
  sessionId: string;
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  nanoAiu?: number;
};

export type AgentHostUsageRecord = {
  key: string;
  timestamp: number;
  model: string;
  turnId?: string;
  agentId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  nanoAiu?: number;
  durationMs?: number;
};

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseCopilotDebugSpan(line: string): CopilotDebugSpan | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;

  const event = value as Record<string, unknown>;
  const attributes = event.attrs;
  if (event.type !== 'llm_request' || typeof event.name !== 'string' || !event.name.startsWith('chat:') || !attributes || typeof attributes !== 'object') return undefined;

  const attrs = attributes as Record<string, unknown>;
  const inputTokens = nonNegativeNumber(attrs.inputTokens);
  const outputTokens = nonNegativeNumber(attrs.outputTokens);
  const timestamp = nonNegativeNumber(event.ts);
  if (inputTokens === undefined || outputTokens === undefined || timestamp === undefined || !Number.isFinite(new Date(timestamp).getTime())) return undefined;

  const sessionId = typeof event.sid === 'string' ? event.sid : '';
  const responseId = typeof attrs.responseId === 'string' ? attrs.responseId : '';
  const key = typeof event.spanId === 'string' && event.spanId
    ? event.spanId
    : responseId
      ? `${sessionId}:${timestamp}:${responseId}`
      : createHash('sha256').update(trimmed).digest('hex');
  const model = typeof attrs.model === 'string' && attrs.model ? attrs.model : event.name.slice('chat:'.length);
  if (!model) return undefined;
  const nanoAiu = nonNegativeNumber(attrs.copilotUsageNanoAiu);

  return {
    key,
    sessionId,
    timestamp,
    model,
    inputTokens,
    outputTokens,
    cachedTokens: nonNegativeNumber(attrs.cachedTokens) ?? 0,
    ...(nanoAiu === undefined ? {} : { nanoAiu })
  };
}

export function parseAgentHostUsageLog(text: string): AgentHostUsageRecord[] {
  const records: AgentHostUsageRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object') continue;

    const event = value as Record<string, unknown>;
    const timestamp = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    if (!Number.isFinite(timestamp)) continue;

    const apiCallId = typeof event.apiCallId === 'string' && event.apiCallId ? event.apiCallId : undefined;
    const eventId = typeof event.eventId === 'string' && event.eventId ? event.eventId : undefined;
    const nanoAiu = nonNegativeNumber(event.totalNanoAiu);
    const inputTokens = nonNegativeNumber(event.inputTokens);
    const outputTokens = nonNegativeNumber(event.outputTokens);
    const cachedTokens = nonNegativeNumber(event.cacheReadTokens);
    if (nanoAiu === undefined && inputTokens === undefined && outputTokens === undefined) continue;

    records.push({
      key: apiCallId ?? eventId ?? createHash('sha256').update(trimmed).digest('hex'),
      timestamp,
      model: typeof event.model === 'string' && event.model ? event.model : 'unknown',
      ...(typeof event.turnId === 'string' && event.turnId ? { turnId: event.turnId } : {}),
      ...(typeof event.agentId === 'string' && event.agentId ? { agentId: event.agentId } : {}),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cachedTokens === undefined ? {} : { cachedTokens }),
      ...(nanoAiu === undefined ? {} : { nanoAiu }),
      ...(nonNegativeNumber(event.durationMs) === undefined ? {} : { durationMs: nonNegativeNumber(event.durationMs) })
    });
  }

  const rootUsageTurns = new Set(records
    .filter(record => !record.agentId && record.turnId && record.nanoAiu !== undefined)
    .map(record => record.turnId as string));
  const totalNanoAiuByTurn = new Map<string, number>();
  return records.map(record => {
    if (record.agentId && record.turnId && rootUsageTurns.has(record.turnId) && record.nanoAiu !== undefined) {
      return { ...record, nanoAiu: 0 };
    }
    if (!record.turnId || record.nanoAiu === undefined) return record;

    const previous = totalNanoAiuByTurn.get(record.turnId) ?? 0;
    const total = Math.max(previous, record.nanoAiu);
    totalNanoAiuByTurn.set(record.turnId, total);
    return { ...record, nanoAiu: Math.max(0, record.nanoAiu - previous) };
  });
}

export function filterAgentHostUsageForWorkspace(records: readonly AgentHostUsageRecord[], workspaceTurnIds: ReadonlySet<string>, sessionId: string, workspaceChatIds: ReadonlySet<string>): AgentHostUsageRecord[] {
  return records.filter(record => workspaceChatIds.has(sessionId)
    || Boolean(record.turnId && workspaceTurnIds.has(record.turnId)));
}