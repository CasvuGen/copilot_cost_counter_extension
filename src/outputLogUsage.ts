export type ParsedOutputUsage = {
  requestId: string;
  timestamp: string;
  model: string;
  feature: string;
  durationMs: number;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  cacheWriteTokens: number | null;
};

function numberFromLine(line: string, names: string[]): number | undefined {
  const namePattern = names.join('|');
  const match = line.match(new RegExp(`(?:${namePattern})[=:]\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : undefined;
}

export function parseOutputLogUsageLine(line: string): ParsedOutputUsage | undefined {
  const match = line.match(/ccreq:([^\s.]+)\.copilotmd\s+\|\s+(success|cancelled|failed)\s+\|\s+([^|]+?)\s+\|\s+(\d+)ms\s+\|\s+\[([^\]]+)\]/i);
  if (!match || match[2].toLowerCase() !== 'success') return undefined;

  return {
    requestId: match[1],
    timestamp: line.slice(0, 23),
    model: match[3].trim(),
    feature: match[5],
    durationMs: Number(match[4]),
    promptTokens: numberFromLine(line, ['prompt_tokens', 'promptTokenCount', 'input_tokens']) ?? null,
    outputTokens: numberFromLine(line, ['completion_tokens', 'responseTokenCount', 'output_tokens']) ?? null,
    cacheTokens: numberFromLine(line, ['cached_tokens', 'cacheTokens']) ?? null,
    cacheWriteTokens: numberFromLine(line, ['cache_write_tokens', 'cacheWriteTokens']) ?? null
  };
}