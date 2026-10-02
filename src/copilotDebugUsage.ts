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