import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isPersistedChatTitleSource, isUsableConversationTitle, persistedChatSessionFromJsonl, sessionTitleFromJsonl, sessionTitleFromMetadata } from './chatMetadata';
import generatedPricing from './pricing.generated.json';

const usageDirectory = '.copilot';
const usageFileName = 'usage.jsonl';
const usageMetadataFileName = 'usage_metadata.json';
const usageMetadataSchemaId = 3;
const usageSchemaId = 7;
const pricingSource = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';

type ModelPricing = { input: number; cachedInput?: number; cacheWrite?: number; output: number };
type PricingOverrides = Record<string, Partial<ModelPricing>>;
type GeneratedPricingRow = { model: string; tier: string; since: string; input: number; cachedInput?: number; cacheWrite?: number; output: number };
type RequestType = 'chat' | 'completion' | 'nextEditSuggestion' | 'utility';
const generatedRows = generatedPricing as GeneratedPricingRow[];
const fallbackPricing: Record<string, ModelPricing> = Object.fromEntries(
  generatedRows.filter(row => row.tier.toLowerCase() === 'default' || !generatedRows.some(other => other.model === row.model && other.tier.toLowerCase() === 'default')).map(row => [row.model.toLowerCase().replace(/[^a-z0-9.]+/g, '-'), row])
);
const pricing: Record<string, ModelPricing> = fallbackPricing;
const pricingUpdatedAt: string | null = generatedRows.length > 0 ? new Date().toISOString() : null;

type UsageRecord = {
  schemaId: number;
  timestamp: string;
  sourceLog: string;
  requestId: string;
  chatId?: string;
  turnId?: string;
  conversationTitle?: string;
  conversationTitleSource?: 'copilot' | 'firstUserMessage';
  firstUserMessage?: string;
  toolNames?: string[];
  toolCallCount?: number;
  model: string;
  feature: string;
  requestType: RequestType;
  durationMs: number;
  promptTokens: number | null;
  freshInputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  cacheWriteTokens: number | null;
  inputRateUsdPerMillion: number | null;
  outputRateUsdPerMillion: number | null;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  cacheCostUsd: number | null;
  cacheWriteCostUsd: number | null;
  costUsd: number | null;
  inputCreditsPerMillion: number | null;
  cachedInputCreditsPerMillion: number | null;
  cacheWriteCreditsPerMillion: number | null;
  outputCreditsPerMillion: number | null;
  inputCredits: number | null;
  cachedInputCredits: number | null;
  cacheWriteCredits: number | null;
  outputCredits: number | null;
  aiCredits: number | null;
  copilotUsage: CopilotUsage | null;
  pricingSource: string;
  pricingUpdatedAt: string | null;
  costKind: 'estimated' | 'unavailable';
};

type ChatMetadata = {
  chatId: string;
  title: string;
  titleSource: 'copilot' | 'firstUserMessage' | 'unavailable';
  titleHistory?: { title: string; observedAt: string }[];
  turnIds: string[];
  firstSeen: string;
  lastSeen: string;
};

type ReportRecord = Pick<UsageRecord, 'schemaId' | 'timestamp' | 'sourceLog' | 'requestId' | 'chatId' | 'turnId' | 'conversationTitle' | 'conversationTitleSource' | 'firstUserMessage' | 'toolNames' | 'toolCallCount' | 'model' | 'feature' | 'requestType' | 'durationMs' | 'promptTokens' | 'freshInputTokens' | 'outputTokens' | 'cacheTokens' | 'cacheWriteTokens' | 'inputRateUsdPerMillion' | 'outputRateUsdPerMillion' | 'aiCredits' | 'costUsd' | 'costKind'>;
type CopilotUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; accepted_prediction_tokens?: number; rejected_prediction_tokens?: number };
  copilot_usage?: { total_nano_aiu?: number; token_details?: CopilotUsageTokenDetail[] };
};
type CopilotUsageTokenDetail = { batch_size?: number; cost_per_batch?: number; model?: string; token_count?: number; token_type?: string };
type CopilotRequest = { usage?: CopilotUsage; chatId?: string; turnId?: string; conversationTitle?: string; toolNames?: string[]; toolCallCount?: number };
type CopilotSessionMetadata = { customTitle?: unknown };
type ReportTemplates = {
  report: string;
  card: string;
  dailyBar: string;
  dailyChart: string;
  modelRow: string;
  recentRow: string;
  recentTable: string;
  chatGroup: string;
  turnGroup: string;
  chatRow: string;
  chatTable: string;
  pricingNotice: string;
  empty: string;
};

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

function findStringByKey(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof nested === 'string' && nested.length > 0) return nested;
    const found = findStringByKey(nested, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function conversationTitleFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (/response|completion|assistant/i.test(key)) {
      const title = lastText(nested);
      if (title) return title;
    }
    const title = conversationTitleFromValue(nested, depth + 1);
    if (title) return title;
  }
  return undefined;
}

function lastText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const title = value.trim().replace(/^['"`]+|['"`]+$/g, '');
    return title.length > 0 && title.length <= 160 ? title : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const title = lastText(value[index]);
      if (title) return title;
    }
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.values(value);
    for (let index = entries.length - 1; index >= 0; index--) {
      const title = lastText(entries[index]);
      if (title) return title;
    }
  }
  return undefined;
}

function toolUsageFromValue(value: unknown, names = new Set<string>(), depth = 0): { names: string[]; count: number } {
  if (depth > 8 || value === null || typeof value !== 'object') return { names: [...names], count: 0 };
  let count = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = toolUsageFromValue(item, names, depth + 1);
      count += nested.count;
    }
    return { names: [...names], count };
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (/tool[_-]?calls?|tool[_-]?uses?/i.test(key)) {
      const values = Array.isArray(nestedValue) ? nestedValue : [nestedValue];
      for (const toolCall of values) {
        count += 1;
        const name = typeof toolCall === 'object' && toolCall !== null
          ? findStringByKey(toolCall, new Set(['name', 'toolname', 'functionname']))
          : undefined;
        if (name) names.add(name);
      }
    }
    const nested = toolUsageFromValue(nestedValue, names, depth + 1);
    count += nested.count;
  }
  return { names: [...names], count };
}

async function loadReportTemplates(extensionPath: string): Promise<ReportTemplates> {
  const templatePath = (name: string) => path.join(extensionPath, 'templates', name);
  const [report, card, dailyBar, dailyChart, modelRow, recentRow, recentTable, chatGroup, turnGroup, chatRow, chatTable, pricingNotice, empty] = await Promise.all([
    fs.readFile(templatePath('report.html'), 'utf8'),
    fs.readFile(templatePath('card.html'), 'utf8'),
    fs.readFile(templatePath('daily-bar.html'), 'utf8'),
    fs.readFile(templatePath('daily-chart.html'), 'utf8'),
    fs.readFile(templatePath('model-row.html'), 'utf8'),
    fs.readFile(templatePath('recent-row.html'), 'utf8'),
    fs.readFile(templatePath('recent-table.html'), 'utf8'),
    fs.readFile(templatePath('chat-group.html'), 'utf8'),
    fs.readFile(templatePath('turn-group.html'), 'utf8'),
    fs.readFile(templatePath('chat-row.html'), 'utf8'),
    fs.readFile(templatePath('chat-table.html'), 'utf8'),
    fs.readFile(templatePath('pricing-notice.html'), 'utf8'),
    fs.readFile(templatePath('empty.html'), 'utf8')
  ]);
  return { report, card, dailyBar, dailyChart, modelRow, recentRow, recentTable, chatGroup, turnGroup, chatRow, chatTable, pricingNotice, empty };
}

function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]+\]/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

function numberFromLine(line: string, names: string[]): number | undefined {
  const namePattern = names.join('|');
  const match = line.match(new RegExp(`(?:${namePattern})[=:]\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : undefined;
}

function usageTokenCount(usage: CopilotUsage, tokenType: string): number | undefined {
  return usage.copilot_usage?.token_details?.find(detail => detail.token_type === tokenType && typeof detail.token_count === 'number')?.token_count;
}

function classifyRequestType(feature: string): RequestType {
  const normalized = feature.toLowerCase();
  if (/next.?edit|\bnes\b/.test(normalized)) return 'nextEditSuggestion';
  if (/inline|completion/.test(normalized)) return 'completion';
  if (/^tool\/runsubagent-/i.test(feature)) return 'chat';
  if (/progressmessages|copilotlanguagemodelwrapper|tool|summarizeconversation|xtabprovider|healapplypatch|title/.test(normalized)) return 'utility';
  return 'chat';
}

function requestTypeOf(record: Pick<ReportRecord, 'requestType' | 'feature'>): RequestType {
  return record.requestType ?? classifyRequestType(record.feature);
}

function requestTypeLabel(record: Pick<ReportRecord, 'requestType' | 'feature'>): string {
  const type = requestTypeOf(record);
  return type === 'nextEditSuggestion' ? 'Next edit suggestion' : type === 'completion' ? 'Completion' : type === 'utility' ? 'Utility' : 'Chat';
}

const displayNumber = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function formatDecimal(value: number): string {
  if (value === 0) return '-';
  return displayNumber.format(Math.floor(value * 10) / 10);
}

function formatMoney(valueUsd: number): string {
  if (valueUsd === 0) return '-';
  const configuration = vscode.workspace.getConfiguration('copilotCostCounter');
  const currency = configuration.get<string>('currency', 'USD');
  const conversionRate = configuration.get<number>('currencyConversionRate', 1);
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.floor(valueUsd * conversionRate * 10) / 10);
}

function formatRecentMoney(valueUsd: number): string {
  if (valueUsd === 0) return '-';
  const configuration = vscode.workspace.getConfiguration('copilotCostCounter');
  const currency = configuration.get<string>('currency', 'USD');
  const conversionRate = configuration.get<number>('currencyConversionRate', 1);
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency, minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(Math.floor(valueUsd * conversionRate * 1000) / 1000);
}

function formatBurnMoney(valueUsd: number): string {
  const configuration = vscode.workspace.getConfiguration('copilotCostCounter');
  const currency = configuration.get<string>('currency', 'USD');
  const conversionRate = configuration.get<number>('currencyConversionRate', 1);
  const displayValue = Math.abs(valueUsd * conversionRate);
  const fractionDigits = displayValue >= 1 ? 2 : displayValue >= .1 ? 3 : displayValue >= .01 ? 4 : displayValue >= .001 ? 5 : 6;
  const truncated = Math.floor(valueUsd * conversionRate * 10 ** fractionDigits) / 10 ** fractionDigits;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(truncated);
}

function formatUnavailable(record: Pick<ReportRecord, 'requestType' | 'feature'>): string {
  return requestTypeOf(record) === 'utility' ? '-' : '<span class="muted">Unavailable</span>';
}

function formatActivityDate(timestamp: string): string {
  return timestamp.replace('T', ' ').slice(0, 16);
}

function formatToolUsage(record: Pick<ReportRecord, 'toolNames' | 'toolCallCount'>): string {
  if (!record.toolCallCount) return '';
  const names = record.toolNames?.length ? `: ${record.toolNames.join(', ')}` : '';
  return ` · ${record.toolCallCount} tool${record.toolCallCount === 1 ? '' : 's'}${names}`;
}

function configuredPricing(): Record<string, ModelPricing> {
  const configured = vscode.workspace.getConfiguration('copilotCostCounter').get<PricingOverrides>('modelPricingOverrides', {});
  const overrides: Record<string, ModelPricing> = { ...pricing };
  for (const [model, value] of Object.entries(configured)) {
    const normalized = normalizeModel(model);
    const current = overrides[normalized];
    if (typeof value.input !== 'number' || typeof value.output !== 'number') continue;
    overrides[normalized] = {
      input: value.input,
      output: value.output,
      cachedInput: typeof value.cachedInput === 'number' ? value.cachedInput : current?.cachedInput,
      cacheWrite: typeof value.cacheWrite === 'number' ? value.cacheWrite : current?.cacheWrite
    };
  }
  return overrides;
}

async function findCopilotLogs(directory: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && /^GitHub Copilot Chat(?:\.\d+)?\.log$/i.test(entry.name)) files.push(entryPath);
    if (entry.isDirectory()) files.push(...await findCopilotLogs(entryPath, depth + 1));
  }
  return files;
}

async function discoverCopilotLogs(logRoot: string): Promise<string[]> {
  const candidates = await findCopilotLogs(logRoot);
  const withStats = await Promise.all(candidates.map(async candidate => {
    try {
      return { candidate, modified: (await fs.stat(candidate)).mtimeMs };
    } catch {
      return undefined;
    }
  }));
  return withStats.filter((entry): entry is { candidate: string; modified: number } => entry !== undefined)
    .sort((left, right) => left.modified - right.modified)
    .map(entry => entry.candidate);
}

function conversationIdFromLine(line: string): string | undefined {
  const match = line.match(/\[ChatWebSocketManager\][^\r\n]*conversation\s+([0-9a-f]{8}-[0-9a-f-]{27,})/i);
  return match?.[1];
}

function turnIdFromLine(line: string): string | undefined {
  const match = line.match(/(?:turn(?:Id|_id)?|userTurnId|turn)[\s:=]+(request_[0-9a-f-]{36}|[0-9a-f]{8}-[0-9a-f-]{27,})/i);
  return match?.[1];
}

function newConversationIdFromLine(line: string): string | undefined {
  const match = line.match(/\[ChatWebSocketManager\]\s+New request for conversation\s+([0-9a-f-]{36})\s+turn\s+request_[0-9a-f-]{36}\s+\(previous turn:\s+undefined\)/i);
  return match?.[1];
}

function voiceProgressRequestIdFromLine(line: string): string | undefined {
  const match = line.match(/\[VoiceProgress\]\s+fallback\s+request=(request_[0-9a-f-]{36}|[0-9a-f-]{36})/i);
  return match?.[1];
}

function voiceProgressLoopFromLine(line: string): { requestId: string; isSubagent: boolean } | undefined {
  const match = line.match(/\[VoiceProgress\]\s+loop\s+request=(request_[0-9a-f-]{36}|[0-9a-f-]{36}).*?\bsubagent=(true|false)/i);
  return match ? { requestId: match[1], isSubagent: match[2].toLowerCase() === 'true' } : undefined;
}

function websocketResponseDurationFromLine(line: string): number | undefined {
  const match = line.match(/request\.response:\s+\[websocket\],\s+took\s+(\d+)\s+ms/i);
  return match ? Number(match[1]) : undefined;
}

function timestampFromLine(line: string): number | undefined {
  const timestamp = Date.parse(line.slice(0, 23).replace(' ', 'T'));
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseLine(line: string, sourceLog: string, chatId?: string, turnId?: string): UsageRecord | undefined {
  const match = line.match(/ccreq:([^\s.]+)\.copilotmd\s+\|\s+(success|cancelled|failed)\s+\|\s+([^|]+?)\s+\|\s+(\d+)ms\s+\|\s+\[([^\]]+)\]/i);
  if (!match || match[2].toLowerCase() !== 'success') {
    return undefined;
  }

  const model = match[3].trim();
  const promptTokens = numberFromLine(line, ['prompt_tokens', 'promptTokenCount', 'input_tokens']) ?? null;
  const outputTokens = numberFromLine(line, ['completion_tokens', 'responseTokenCount', 'output_tokens']) ?? null;
  const cacheTokens = numberFromLine(line, ['cached_tokens', 'cacheTokens']) ?? null;
  const cacheWriteTokens = numberFromLine(line, ['cache_write_tokens', 'cacheWriteTokens']) ?? null;
  const modelPricing = configuredPricing()[normalizeModel(model)];
  const freshInputTokens = promptTokens === null ? null : Math.max(0, promptTokens - (cacheTokens ?? 0));
  const inputCostUsd = modelPricing && freshInputTokens !== null ? freshInputTokens * modelPricing.input / 1_000_000 : null;
  const outputCostUsd = modelPricing && outputTokens !== null ? outputTokens * modelPricing.output / 1_000_000 : null;
  const cacheCostUsd = modelPricing && cacheTokens !== null && modelPricing.cachedInput !== undefined ? cacheTokens * modelPricing.cachedInput / 1_000_000 : null;
  const cacheWriteCostUsd = modelPricing && cacheWriteTokens !== null && modelPricing.cacheWrite !== undefined ? cacheWriteTokens * modelPricing.cacheWrite / 1_000_000 : null;
  const costUsd = inputCostUsd !== null && outputCostUsd !== null ? inputCostUsd + outputCostUsd + (cacheCostUsd ?? 0) + (cacheWriteCostUsd ?? 0) : null;
  const inputCredits = inputCostUsd === null ? null : inputCostUsd / .01;
  const cachedInputCredits = cacheCostUsd === null ? null : cacheCostUsd / .01;
  const cacheWriteCredits = cacheWriteCostUsd === null ? null : cacheWriteCostUsd / .01;
  const outputCredits = outputCostUsd === null ? null : outputCostUsd / .01;

  return {
    schemaId: usageSchemaId,
    timestamp: line.slice(0, 23),
    sourceLog,
    requestId: match[1],
    chatId,
    turnId,
    model,
    feature: match[5],
    requestType: classifyRequestType(match[5]),
    durationMs: Number(match[4]),
    promptTokens,
    freshInputTokens,
    outputTokens,
    cacheTokens,
    cacheWriteTokens,
    inputRateUsdPerMillion: modelPricing?.input ?? null,
    outputRateUsdPerMillion: modelPricing?.output ?? null,
    inputCostUsd,
    outputCostUsd,
    cacheCostUsd,
    cacheWriteCostUsd,
    costUsd,
    inputCreditsPerMillion: modelPricing ? modelPricing.input * 100 : null,
    cachedInputCreditsPerMillion: modelPricing?.cachedInput === undefined ? null : modelPricing.cachedInput * 100,
    cacheWriteCreditsPerMillion: modelPricing?.cacheWrite === undefined ? null : modelPricing.cacheWrite * 100,
    outputCreditsPerMillion: modelPricing ? modelPricing.output * 100 : null,
    inputCredits,
    cachedInputCredits,
    cacheWriteCredits,
    outputCredits,
    aiCredits: costUsd === null ? null : costUsd / .01,
    copilotUsage: null,
    pricingSource,
    pricingUpdatedAt,
    costKind: costUsd === null ? 'unavailable' : 'estimated'
  };
}

function applyCopilotUsage(record: UsageRecord, usage: CopilotUsage, chatId = record.chatId): UsageRecord {
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : record.promptTokens;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : record.outputTokens;
  const cacheTokens = typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? usage.prompt_tokens_details.cached_tokens : record.cacheTokens;
  const cacheWriteTokens = typeof usage.prompt_tokens_details?.cache_write_tokens === 'number'
    ? usage.prompt_tokens_details.cache_write_tokens
    : usageTokenCount(usage, 'cache_write') ?? record.cacheWriteTokens;
  const modelPricing = configuredPricing()[normalizeModel(record.model)];
  const freshInputTokens = promptTokens === null ? null : Math.max(0, promptTokens - (cacheTokens ?? 0));
  const inputCostUsd = modelPricing && freshInputTokens !== null ? freshInputTokens * modelPricing.input / 1_000_000 : null;
  const outputCostUsd = modelPricing && outputTokens !== null ? outputTokens * modelPricing.output / 1_000_000 : null;
  const cacheCostUsd = modelPricing && cacheTokens !== null && modelPricing.cachedInput !== undefined ? cacheTokens * modelPricing.cachedInput / 1_000_000 : null;
  const cacheWriteCostUsd = modelPricing && cacheWriteTokens !== null && modelPricing.cacheWrite !== undefined ? cacheWriteTokens * modelPricing.cacheWrite / 1_000_000 : null;
  const tokenCostUsd = inputCostUsd !== null && outputCostUsd !== null ? inputCostUsd + outputCostUsd + (cacheCostUsd ?? 0) + (cacheWriteCostUsd ?? 0) : null;
  const nanoAiu = usage.copilot_usage?.total_nano_aiu;
  const hasCopilotUsage = typeof nanoAiu === 'number' && Number.isFinite(nanoAiu) && nanoAiu >= 0;
  const aiCredits = hasCopilotUsage ? nanoAiu / 1_000_000_000 : tokenCostUsd === null ? null : tokenCostUsd / .01;
  const costUsd = hasCopilotUsage ? (nanoAiu / 1_000_000_000) * .01 : tokenCostUsd;
  return {
    ...record,
    chatId,
    promptTokens,
    freshInputTokens,
    outputTokens,
    cacheTokens,
    cacheWriteTokens,
    inputRateUsdPerMillion: modelPricing?.input ?? null,
    outputRateUsdPerMillion: modelPricing?.output ?? null,
    inputCostUsd,
    outputCostUsd,
    cacheCostUsd,
    cacheWriteCostUsd,
    costUsd,
    inputCreditsPerMillion: modelPricing ? modelPricing.input * 100 : null,
    cachedInputCreditsPerMillion: modelPricing?.cachedInput === undefined ? null : modelPricing.cachedInput * 100,
    cacheWriteCreditsPerMillion: modelPricing?.cacheWrite === undefined ? null : modelPricing.cacheWrite * 100,
    outputCreditsPerMillion: modelPricing ? modelPricing.output * 100 : null,
    inputCredits: inputCostUsd === null ? null : inputCostUsd / .01,
    cachedInputCredits: cacheCostUsd === null ? null : cacheCostUsd / .01,
    cacheWriteCredits: cacheWriteCostUsd === null ? null : cacheWriteCostUsd / .01,
    outputCredits: outputCostUsd === null ? null : outputCostUsd / .01,
    aiCredits,
    copilotUsage: usage,
    costKind: costUsd === null ? 'unavailable' : 'estimated'
  };
}

async function readCopilotRequest(requestId: string): Promise<CopilotRequest | undefined> {
  try {
    const canonicalRequestId = requestId.replace(/\.copilotmd$/i, '');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(`ccreq:${canonicalRequestId}.json`));
    const value = JSON.parse(document.getText()) as Record<string, unknown>;
    const metadata = (value.metadata ?? {}) as Record<string, unknown>;
    const usage = (metadata.usage ?? value.usage) as CopilotUsage | undefined;
    const chatId = findStringByKey(value, new Set(['conversationid', 'chatid']));
    const turnId = findStringByKey(value, new Set(['turnid', 'turn_id', 'userturnid']));
    const conversationTitle = conversationTitleFromValue(value);
    const toolUsage = toolUsageFromValue(value);
    return { usage, chatId, turnId, conversationTitle, toolNames: toolUsage.names, toolCallCount: toolUsage.count };
  } catch {
    return undefined;
  }
}

async function readUsageRecords(): Promise<ReportRecord[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  try {
    const content = await fs.readFile(path.join(folder.uri.fsPath, usageDirectory, usageFileName), 'utf8');
    return content.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try {
        const record = JSON.parse(line) as Partial<ReportRecord>;
        return typeof record.requestId === 'string' ? [{ ...record, schemaId: typeof record.schemaId === 'number' ? record.schemaId : 1 } as ReportRecord] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function readChatMetadata(): Promise<ChatMetadata[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  try {
    const content = await fs.readFile(path.join(folder.uri.fsPath, usageDirectory, usageMetadataFileName), 'utf8');
    const value = JSON.parse(content) as { schemaId?: unknown; chats?: unknown };
    if ((value.schemaId !== 1 && value.schemaId !== 2 && value.schemaId !== usageMetadataSchemaId) || !Array.isArray(value.chats)) return [];
    return value.chats.filter((chat): chat is ChatMetadata => typeof chat === 'object' && chat !== null && typeof (chat as ChatMetadata).chatId === 'string').map(chat => {
      if (isPersistedChatTitleSource(chat.titleSource)) return chat;
      const { title: _title, titleHistory: _titleHistory, titleSource: _titleSource, ...legacyChat } = chat;
      return { ...legacyChat, title: `Chat ${legacyChat.chatId.slice(0, 12)}`, titleSource: 'unavailable' as const };
    });
  } catch {
    return [];
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function sessionTitleFromFile(filePath: string): Promise<string | undefined> {
  try {
    return sessionTitleFromJsonl(await fs.readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

async function readPersistedChatTitle(workspaceStoragePath: string, chatId: string, turnIds: readonly string[] = []): Promise<{ title: string; titleSource: 'copilot' | 'firstUserMessage' } | undefined> {
  const copilotHome = process.env.COPILOT_HOME || path.join(homedir(), '.copilot');
  const sessionMetadataPath = path.join(copilotHome, 'session-state', chatId, 'vscode.metadata.json');
  const sessionMetadata = await readJsonFile<CopilotSessionMetadata>(sessionMetadataPath);
  const sessionTitle = sessionTitleFromMetadata(sessionMetadata);
  if (sessionTitle) return { title: sessionTitle, titleSource: 'copilot' };

  const cachedMetadata = await readJsonFile<Record<string, CopilotSessionMetadata>>(path.join(copilotHome, 'vscode.session.metadata.cache.json'));
  const cachedTitle = sessionTitleFromMetadata(cachedMetadata?.[chatId]);
  if (cachedTitle) return { title: cachedTitle, titleSource: 'copilot' };

  const persistedChat = turnIds.length ? await persistedChatForTurn(workspaceStoragePath, turnIds[0]) : undefined;
  return persistedChat?.title && persistedChat.titleSource ? { title: persistedChat.title, titleSource: persistedChat.titleSource } : undefined;
}

async function persistedChatForTurn(workspaceStoragePath: string, turnId: string): Promise<{ chatId: string; title?: string; titleSource?: 'copilot' | 'firstUserMessage'; firstUserMessage?: string } | undefined> {
  const chatsByTurn = await persistedChatsByTurn(workspaceStoragePath);
  return chatsByTurn.get(turnId);
}

async function persistedChatsByTurn(workspaceStoragePath: string): Promise<Map<string, { chatId: string; title?: string; titleSource?: 'copilot' | 'firstUserMessage'; firstUserMessage?: string }>> {
  const chatsByTurn = new Map<string, { chatId: string; title?: string; titleSource?: 'copilot' | 'firstUserMessage'; firstUserMessage?: string }>();
  const chatSessionsDirectory = path.join(workspaceStoragePath, 'chatSessions');
  try {
    const entries = await fs.readdir(chatSessionsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.jsonl$/i.test(entry.name)) continue;
      const content = await fs.readFile(path.join(chatSessionsDirectory, entry.name), 'utf8');
      const session = persistedChatSessionFromJsonl(content);
      if (!session) continue;
      for (const turnId of session.turnIds) chatsByTurn.set(turnId, { chatId: session.chatId, ...(session.title ? { title: session.title, titleSource: session.titleSource } : {}), ...(session.firstUserMessage ? { firstUserMessage: session.firstUserMessage } : {}) });
    }
  } catch {
    return chatsByTurn;
  }
  return chatsByTurn;
}

async function ensureChatMetadataTitles(): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return false;
  const metadataPath = path.join(folder.uri.fsPath, usageDirectory, usageMetadataFileName);
  const value = await readJsonFile<{ chats?: unknown }>(metadataPath);
  if (!Array.isArray(value?.chats)) return false;
  let changed = false;
  const chats = value.chats.map(chat => {
    if (typeof chat !== 'object' || chat === null || typeof (chat as ChatMetadata).chatId !== 'string') return chat;
    const metadata = chat as Partial<ChatMetadata>;
    if (metadata.title) return chat;
    changed = true;
    return { ...metadata, title: `Chat ${metadata.chatId!.slice(0, 12)}`, titleSource: 'unavailable' };
  });
  if (changed) await fs.writeFile(metadataPath, `${JSON.stringify({ schemaId: usageMetadataSchemaId, chats }, null, 2)}\n`, 'utf8');
  return changed;
}

async function updateChatMetadata(record: UsageRecord): Promise<void> {
  if (!record.chatId) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const metadataPath = path.join(folder.uri.fsPath, usageDirectory, usageMetadataFileName);
  const chats = await readChatMetadata();
  const existing = chats.find(chat => chat.chatId === record.chatId);
  const turnIds = new Set(existing?.turnIds ?? []);
  if (requestTypeOf(record) === 'chat' && record.turnId) turnIds.add(record.turnId);
  const useExistingTitle = existing?.titleSource === 'copilot' && record.conversationTitleSource !== 'copilot';
  const title = useExistingTitle ? existing.title : record.conversationTitle ?? existing?.title ?? `Chat ${record.chatId.slice(0, 12)}`;
  const metadata: ChatMetadata = {
    chatId: record.chatId,
    title,
    titleSource: useExistingTitle ? 'copilot' : record.conversationTitleSource ?? existing?.titleSource ?? 'unavailable',
    ...(existing?.titleHistory ? { titleHistory: existing.titleHistory } : {}),
    turnIds: [...turnIds],
    firstSeen: existing?.firstSeen ?? record.timestamp,
    lastSeen: record.timestamp
  };
  const next = [...chats.filter(chat => chat.chatId !== record.chatId), metadata];
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, `${JSON.stringify({ schemaId: usageMetadataSchemaId, chats: next }, null, 2)}\n`, 'utf8');
}

class UsageReportProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private refreshLog: (() => Promise<void>) | undefined;
  private pendingMoneyBurnUsd = 0;

  constructor(private readonly templates: ReportTemplates) {}

  setRefreshLog(refreshLog: () => Promise<void>): void {
    this.refreshLog = refreshLog;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(message => {
      if (message.type === 'refresh') void this.refreshLog?.();
      if (message.type === 'openUsage') void vscode.commands.executeCommand('copilotCostCounter.openUsage');
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    this.view.webview.html = renderReportFromTemplates(await readUsageRecords(), await readChatMetadata(), this.templates);
  }

  showMoneyBurn(costUsd: number | null): void {
    if (!this.view || costUsd === null || costUsd <= 0) return;
    const configuration = vscode.workspace.getConfiguration('copilotCostCounter');
    if (!configuration.get<boolean>('showMoneyBurn', false)) return;
    const thresholdUsd = configuration.get<number>('moneyBurnThresholdUsd', 0);
    const amountUsd = thresholdUsd > 0
      ? (() => {
        this.pendingMoneyBurnUsd += costUsd;
        const crossed = Math.floor(this.pendingMoneyBurnUsd / thresholdUsd);
        this.pendingMoneyBurnUsd %= thresholdUsd;
        return crossed * thresholdUsd;
      })()
      : costUsd;
    if (amountUsd <= 0) return;
    const durationMs = Math.max(100, Math.min(10000, configuration.get<number>('moneyBurnDurationMs', 2000)));
    const sizePx = Math.max(8, Math.min(72, configuration.get<number>('moneyBurnSizePx', 28)));
    const origin = configuration.get<string>('moneyBurnOrigin', 'bottom-right');
    void this.view.webview.postMessage({ type: 'moneyBurn', amount: formatBurnMoney(amountUsd), durationMs, sizePx, origin });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function renderReportFromTemplates(records: ReportRecord[], chatMetadata: ChatMetadata[], templates: ReportTemplates): string {
  const nonce = createNonce();
  const billableRecords = records.filter(record => requestTypeOf(record) !== 'utility');
  const estimated = billableRecords.filter(record => record.costKind === 'estimated' && record.costUsd !== null);
  const totalUsd = estimated.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const totalCredits = estimated.reduce((sum, record) => sum + (record.aiCredits ?? 0), 0);
  const tokenTotals = records.reduce((totals, record) => ({
    prompt: totals.prompt + (record.promptTokens ?? 0), input: totals.input + (record.freshInputTokens ?? 0), output: totals.output + (record.outputTokens ?? 0),
    cache: totals.cache + (record.cacheTokens ?? 0), cacheWrite: totals.cacheWrite + (record.cacheWriteTokens ?? 0)
  }), { prompt: 0, input: 0, output: 0, cache: 0, cacheWrite: 0 });
  const tokenRecords = records.filter(record => record.promptTokens !== null || record.outputTokens !== null || record.cacheTokens !== null || record.cacheWriteTokens !== null).length;
  const missingPriceModels = [...new Set(billableRecords.filter(record => (record.promptTokens !== null || record.outputTokens !== null || record.cacheTokens !== null || record.cacheWriteTokens !== null) && (record.inputRateUsdPerMillion === null || record.outputRateUsdPerMillion === null)).map(record => record.model))];
  const byDay = new Map<string, number>();
  const byChat = new Map<string, number>();
  const byFeature = new Map<string, number>();
  const byModel = new Map<string, { cost: number; requests: number }>();
  const conversationTitles = new Map<string, string>();
  for (const chat of chatMetadata) {
    if (chat.title) conversationTitles.set(chat.chatId, chat.title);
  }
  for (const record of records) {
    if (record.chatId && isPersistedChatTitleSource(record.conversationTitleSource) && record.conversationTitle && !conversationTitles.has(record.chatId)) conversationTitles.set(record.chatId, record.conversationTitle);
  }
  for (const record of estimated) {
    const day = record.timestamp.slice(0, 10) || 'Unknown';
    byDay.set(day, (byDay.get(day) ?? 0) + (record.costUsd ?? 0));
    const chat = record.chatId ? conversationTitles.get(record.chatId) ?? `Chat ${record.chatId.slice(0, 12)}` : 'Requests without chat metadata';
    byChat.set(chat, (byChat.get(chat) ?? 0) + (record.costUsd ?? 0));
    byFeature.set(record.feature, (byFeature.get(record.feature) ?? 0) + (record.costUsd ?? 0));
    const model = byModel.get(record.model) ?? { cost: 0, requests: 0 };
    model.cost += record.costUsd ?? 0;
    model.requests += 1;
    byModel.set(record.model, model);
  }
  const maxModel = Math.max(...[...byModel.values()].map(model => model.cost), 0.000001);
  const empty = (message: string) => fillTemplate(templates.empty, { message: escapeHtml(message) });
  const card = (label: string, value: string) => fillTemplate(templates.card, { label: escapeHtml(label), value: escapeHtml(value) });
  const spendChart = (entries: [string, number][], label: (key: string) => string) => {
    const maximum = Math.max(...entries.map(([, cost]) => cost), 0.000001);
    return entries.length ? fillTemplate(templates.dailyChart, { bars: entries.map(([key, cost]) => fillTemplate(templates.dailyBar, {
      height: String(Math.max(4, cost / maximum * 100)), title: escapeHtml(`${key}: ${formatMoney(cost)}`), day: escapeHtml(label(key))
    })).join('') }) : empty('No estimated cost data yet.');
  };
  const spendCharts = {
    daily: spendChart([...byDay.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-14), day => day.slice(5)),
    chat: spendChart([...byChat.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10), chat => chat.slice(0, 14)),
    feature: spendChart([...byFeature.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10), feature => feature.slice(0, 14))
  };
  const modelBreakdown = byModel.size ? [...byModel.entries()].sort((left, right) => right[1].cost - left[1].cost).slice(0, 6).map(([model, value]) => fillTemplate(templates.modelRow, {
    model: escapeHtml(model), cost: escapeHtml(formatMoney(value.cost)), width: String(value.cost / maxModel * 100), requests: String(value.requests), plural: value.requests === 1 ? '' : 's'
  })).join('') : empty('No model cost data yet.');
  const rows = records.slice(-20).reverse().map(record => fillTemplate(templates.recentRow, {
    requestId: escapeHtml(record.requestId), style: requestTypeOf(record) === 'utility' || record.costUsd === 0 ? 'opacity:.55' : '', timestamp: escapeHtml(record.timestamp.replace('T', ' ').slice(0, 16)), model: escapeHtml(record.model),
    requestType: escapeHtml(record.feature), cost: record.costUsd === null ? formatUnavailable(record) : formatRecentMoney(record.costUsd), credits: record.aiCredits === null ? formatUnavailable(record) : formatDecimal(record.aiCredits)
  })).join('');
  const recentRequests = rows ? fillTemplate(templates.recentTable, { rows }) : empty('No usage records yet.');
  const chats = new Map<string, ReportRecord[]>();
  for (const record of records.filter(record => requestTypeOf(record) === 'chat' && record.chatId)) {
    const key = record.chatId as string;
    const group = chats.get(key) ?? [];
    group.push(record);
    chats.set(key, group);
  }
  const chatGroups = [...chats.entries()].sort((left, right) => right[1][right[1].length - 1].timestamp.localeCompare(left[1][left[1].length - 1].timestamp)).slice(0, 20).map(([key, chatRecords]) => {
    const estimatedChatCost = chatRecords.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    const conversationTitle = chatRecords.find(record => record.conversationTitleSource === 'copilot')?.conversationTitle;
    const title = conversationTitles.get(key) ?? conversationTitle ?? (key === 'unavailable' ? 'Older requests without chat metadata' : `Chat ${key.slice(0, 12)}`);
    const chatDate = formatActivityDate(chatRecords[chatRecords.length - 1].timestamp);
    const turns = new Map<string, ReportRecord[]>();
    for (const record of chatRecords) {
      const turnKey = record.turnId ?? `request:${record.requestId}`;
      const turn = turns.get(turnKey) ?? [];
      turn.push(record);
      turns.set(turnKey, turn);
    }
    const turnGroups = [...turns.entries()].sort((left, right) => left[1][left[1].length - 1].timestamp.localeCompare(right[1][right[1].length - 1].timestamp)).reverse().map(([turnKey, turnRecords]) => {
      const turnCost = turnRecords.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
      const turnTitle = turnKey.startsWith('request:') ? 'Request without turn metadata' : `Turn ${turnKey.slice(0, 12)}`;
      const requestRows = turnRecords.slice().reverse().map(record => fillTemplate(templates.chatRow, {
        requestId: escapeHtml(record.requestId), style: requestTypeOf(record) === 'utility' || record.costUsd === 0 ? 'opacity:.55' : '', timestamp: escapeHtml(formatActivityDate(record.timestamp)), model: escapeHtml(record.model), requestType: escapeHtml(record.feature), tools: escapeHtml(formatToolUsage(record)),
        cost: record.costUsd === null ? formatUnavailable(record) : formatRecentMoney(record.costUsd)
      })).join('');
      return fillTemplate(templates.turnGroup, {
        turnId: escapeHtml(turnKey), title: escapeHtml(turnTitle), date: escapeHtml(formatActivityDate(turnRecords[turnRecords.length - 1].timestamp)), requests: String(turnRecords.length), plural: turnRecords.length === 1 ? '' : 's', cost: escapeHtml(formatMoney(turnCost)), rows: requestRows
      });
    }).join('');
    return fillTemplate(templates.chatGroup, {
      chatId: escapeHtml(key), title: escapeHtml(title), date: escapeHtml(chatDate), turns: String(turns.size), turnPlural: turns.size === 1 ? '' : 's', cost: escapeHtml(formatMoney(estimatedChatCost)), rows: turnGroups
    });
  }).join('');
  const recentChats = chatGroups ? fillTemplate(templates.chatTable, { groups: chatGroups }) : empty('No chat data available from Copilot metadata.');
  const missingPricingNotice = missingPriceModels.length ? fillTemplate(templates.pricingNotice, { nonce, models: missingPriceModels.map(escapeHtml).join(', ') }) : '';
  return fillTemplate(templates.report, {
    nonce, missingPricingNotice,
    creditCards: [card('Estimated spend', formatMoney(totalUsd)), card('Credits', formatDecimal(totalCredits)), card('Requests', String(records.length)), card('Cost available', `${estimated.length} / ${billableRecords.length}`)].join(''),
    spendCharts: Object.entries(spendCharts).map(([group, chart]) => `<div class="spend-chart" data-spend-chart="${group}"${group === 'daily' ? '' : ' hidden'}>${chart}</div>`).join(''), modelBreakdown,
    tokenCards: [card('Requests', String(records.length)), card('Tokens recorded', `${tokenRecords} / ${records.length}`), card('Input tokens', tokenTotals.input.toLocaleString()), card('Output tokens', tokenTotals.output.toLocaleString()), card('Cached tokens', tokenTotals.cache.toLocaleString()), card('Cache-write tokens', tokenTotals.cacheWrite.toLocaleString())].join(''),
    tokenSummary: `Prompt: ${tokenTotals.prompt.toLocaleString()} | Fresh input: ${tokenTotals.input.toLocaleString()} | Output: ${tokenTotals.output.toLocaleString()} | Cached: ${tokenTotals.cache.toLocaleString()} | Cache write: ${tokenTotals.cacheWrite.toLocaleString()}`,
    recentRequests, recentChats
  });
}

function createNonce(): string {
  return Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64');
}

class UsageCollector implements vscode.Disposable {
  private readonly offsets = new Map<string, number>();
  private readonly pendingTitles = new Map<string, string>();
  private readonly pendingTitleRequests = new Map<string, { requestId: string; timestamp: string; rootTurnId?: string }[]>();
  private readonly pendingNewChats = new Map<string, { chatId: string; timestamp: string }[]>();
  private readonly pendingChatRequests = new Map<string, string[]>();
  private readonly conversationTurns = new Map<string, { chatId: string; turnId: string }>();
  private readonly parentTurnBySubagentRequest = new Map<string, string>();
  private readonly lastRootTurnByLog = new Map<string, string>();
  private readonly websocketRequests = new Map<string, { chatId: string; turnId: string; startedAt: number }[]>();
  private readonly pendingWebsocketResponses = new Map<string, { chatId: string; turnId: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seen = new Set<string>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);

  constructor(private readonly context: vscode.ExtensionContext, private readonly onRecord: (record?: UsageRecord) => void | Promise<void>) {
    this.status.command = 'copilotCostCounter.openUsage';
    this.status.text = '$(pulse) Copilot usage';
    this.status.tooltip = 'Open Copilot usage records';
    this.status.show();
  }

  async start(): Promise<void> {
    await this.loadSeenRecords();
    await this.initializeLogOffsets();
    await this.reconcileStoredRecords();
    await this.poll();
    this.schedule();
  }

  async refresh(): Promise<void> {
    await this.reconcileStoredRecords();
    await this.poll();
  }

  private workspaceStoragePath(): string {
    return path.dirname((this.context.storageUri ?? this.context.logUri).fsPath);
  }

  private async updatePersistedChatTitle(chatId: string, timestamp: string, turnIds: readonly string[] = []): Promise<boolean> {
    const persistedTitle = await readPersistedChatTitle(this.workspaceStoragePath(), chatId, turnIds);
    if (!persistedTitle) return false;
    return this.updateChatTitle(chatId, persistedTitle.title, timestamp, persistedTitle.titleSource);
  }

  private async refreshPersistedChatTitles(records: readonly UsageRecord[]): Promise<boolean> {
    let changed = false;
    const chatTimestamps = new Map<string, { timestamp: string; turnIds: string[]; firstUserMessage?: string }>();
    for (const record of records) {
      if (!record.chatId || requestTypeOf(record) !== 'chat') continue;
      const chat = chatTimestamps.get(record.chatId) ?? { timestamp: record.timestamp, turnIds: [] };
      chat.timestamp = record.timestamp;
      if (record.turnId) chat.turnIds.push(record.turnId);
      chat.firstUserMessage ??= record.firstUserMessage;
      chatTimestamps.set(record.chatId, chat);
    }
    for (const [chatId, chat] of chatTimestamps) {
      changed = await this.updatePersistedChatTitle(chatId, chat.timestamp, chat.turnIds) || changed;
      if (chat.firstUserMessage) changed = await this.updateChatTitle(chatId, chat.firstUserMessage, chat.timestamp, 'firstUserMessage') || changed;
    }
    return changed;
  }

  private async canonicalChatsByRequest(records: readonly UsageRecord[]): Promise<Map<string, { chatId: string; title?: string; titleSource?: 'copilot' | 'firstUserMessage'; firstUserMessage?: string; turnId: string }>> {
    const chats = new Map<string, { chatId: string; title?: string; titleSource?: 'copilot' | 'firstUserMessage'; firstUserMessage?: string; turnId: string }>();
    const chatsByTurn = await persistedChatsByTurn(this.workspaceStoragePath());
    for (const record of records) {
      if (!record.turnId) continue;
      const chat = chatsByTurn.get(record.turnId);
      if (chat) chats.set(record.requestId, { ...chat, turnId: record.turnId });
    }

    const requestIds = new Set(records
      .filter(record => requestTypeOf(record) === 'chat' && !chats.has(record.requestId) && !record.turnId)
      .map(record => record.requestId));
    const rootTurns = new Map<string, string>();
    for (const sourceLog of new Set(records.map(record => record.sourceLog))) {
      try {
        const content = await fs.readFile(sourceLog, 'utf8');
        let rootTurnId: string | undefined;
        for (const line of content.split(/\r?\n/)) {
          const loop = voiceProgressLoopFromLine(line);
          if (loop && !loop.isSubagent) rootTurnId = loop.requestId;
          const requestId = line.match(/ccreq:([^\s.]+)\.copilotmd\s+\|/i)?.[1];
          if (requestId && rootTurnId && requestIds.has(requestId)) rootTurns.set(requestId, rootTurnId);
        }
      } catch {
        continue;
      }
    }
    for (const [requestId, turnId] of rootTurns) {
      const chat = chatsByTurn.get(turnId);
      if (chat) chats.set(requestId, { ...chat, turnId });
    }
    return chats;
  }

  private async reconcileStoredRecords(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const output = path.join(folder.uri.fsPath, usageDirectory, usageFileName);
    let content: string;
    try {
      content = await fs.readFile(output, 'utf8');
    } catch {
      return;
    }
    const lines = content.split(/\r?\n/);
    const storedRecords = lines.flatMap(line => {
      try {
        return line ? [JSON.parse(line) as UsageRecord] : [];
      } catch {
        return [];
      }
    });
    const canonicalChats = await this.canonicalChatsByRequest(storedRecords);
    let changed = false;
    const metadataRecords: UsageRecord[] = [];
    const updated = await Promise.all(lines.map(async line => {
      if (!line) return line;
      try {
        const record = JSON.parse(line) as UsageRecord;
        let updated = record;
        let recordChanged = false;
        const legacySchema = typeof record.schemaId !== 'number' || record.schemaId < usageSchemaId;
        if (record.schemaId !== usageSchemaId) {
          updated = { ...updated, schemaId: usageSchemaId };
          recordChanged = true;
        }
        if (legacySchema && (updated.chatId || updated.turnId)) {
          updated = { ...updated, chatId: undefined, turnId: undefined };
          recordChanged = true;
        }
        const inferredRequestType = classifyRequestType(record.feature);
        if (record.requestType !== inferredRequestType) {
          updated = { ...updated, requestType: inferredRequestType };
          recordChanged = true;
        }
        const persistedChat = canonicalChats.get(updated.requestId);
        if (persistedChat) {
          if (updated.chatId !== persistedChat.chatId || updated.turnId !== persistedChat.turnId || (persistedChat.title && (updated.conversationTitle !== persistedChat.title || updated.conversationTitleSource !== persistedChat.titleSource)) || (persistedChat.firstUserMessage && updated.firstUserMessage !== persistedChat.firstUserMessage)) {
            updated = { ...updated, chatId: persistedChat.chatId, turnId: persistedChat.turnId, ...(persistedChat.title ? { conversationTitle: persistedChat.title, conversationTitleSource: persistedChat.titleSource } : {}), ...(persistedChat.firstUserMessage ? { firstUserMessage: persistedChat.firstUserMessage } : {}) };
            recordChanged = true;
            metadataRecords.push(updated);
          }
        }
        const request = await readCopilotRequest(updated.requestId);
        if (!request) {
          changed = changed || recordChanged;
          return recordChanged ? JSON.stringify(updated) : line;
        }
        if (request.chatId && !updated.chatId) {
          updated = { ...updated, chatId: request.chatId };
          recordChanged = true;
        }
        if (request.turnId && updated.turnId !== request.turnId) {
          updated = { ...updated, turnId: request.turnId };
          recordChanged = true;
        }
        if (updated.requestType === 'utility' && updated.feature.toLowerCase() === 'title' && request.conversationTitle && updated.conversationTitle !== request.conversationTitle) {
          updated = { ...updated, conversationTitle: request.conversationTitle };
          recordChanged = true;
        }
        if (request.toolNames?.length && JSON.stringify(updated.toolNames) !== JSON.stringify(request.toolNames)) {
          updated = { ...updated, toolNames: request.toolNames, toolCallCount: request.toolCallCount };
          recordChanged = true;
        }
        if (request.usage && !updated.copilotUsage) {
          updated = { ...updated, copilotUsage: request.usage };
          recordChanged = true;
        }
        if (updated.costUsd !== null || !request.usage) {
          changed = changed || recordChanged;
          return recordChanged ? JSON.stringify(updated) : line;
        }
        changed = true;
        return JSON.stringify({ ...applyCopilotUsage(updated, request.usage, updated.chatId), schemaId: usageSchemaId });
      } catch {
        return line;
      }
    }));
    if (changed) {
      await fs.writeFile(output, updated.join('\n'), 'utf8');
    }
    for (const record of metadataRecords) await updateChatMetadata(record);
    const records = updated.flatMap(line => {
      try {
        return line ? [JSON.parse(line) as UsageRecord] : [];
      } catch {
        return [];
      }
    });
    if (await ensureChatMetadataTitles() || await this.refreshPersistedChatTitles(records) || changed) await this.onRecord();
  }

  private async loadSeenRecords(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const output = path.join(folder.uri.fsPath, usageDirectory, usageFileName);
    try {
      const content = await fs.readFile(output, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as { requestId?: unknown };
          if (typeof record.requestId === 'string') this.seen.add(record.requestId);
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  private schedule(): void {
    const interval = vscode.workspace.getConfiguration('copilotCostCounter').get('pollIntervalMs', 1000);
    this.timer = setInterval(() => void this.poll(), interval);
  }

  private async logPaths(): Promise<string[]> {
    const configured = vscode.workspace.getConfiguration('copilotCostCounter').get<string>('logPath', '').trim();
    if (configured) {
      return [path.isAbsolute(configured) ? configured : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', configured)];
    }
    return discoverCopilotLogs(path.dirname(this.context.logUri.fsPath));
  }

  private async initializeLogOffsets(): Promise<void> {
    for (const sourceLog of await this.logPaths()) {
      try {
        this.offsets.set(sourceLog, (await fs.stat(sourceLog)).size);
      } catch {
        continue;
      }
    }
  }

  private async poll(): Promise<void> {
    await this.resetIfOutputMissing();
    for (const sourceLog of await this.logPaths()) {
      await this.pollLog(sourceLog);
    }
  }

  private async resetIfOutputMissing(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    try {
      await fs.access(path.join(folder.uri.fsPath, usageDirectory, usageFileName));
    } catch {
      this.seen.clear();
      this.pendingTitles.clear();
      this.pendingTitleRequests.clear();
      this.pendingNewChats.clear();
      this.pendingChatRequests.clear();
      this.conversationTurns.clear();
      this.parentTurnBySubagentRequest.clear();
      this.lastRootTurnByLog.clear();
      this.websocketRequests.clear();
      this.pendingWebsocketResponses.clear();
    }
  }

  private async pollLog(sourceLog: string): Promise<void> {
    let text: string;
    try {
      const stat = await fs.stat(sourceLog);
      if (!this.offsets.has(sourceLog)) {
        this.offsets.set(sourceLog, stat.size);
        return;
      }
      const offset = this.offsets.get(sourceLog) as number;
      const buffer = await fs.readFile(sourceLog);
      const start = stat.size < offset ? 0 : offset;
      text = buffer.subarray(start).toString('utf8');
      this.offsets.set(sourceLog, buffer.length);
    } catch {
      return;
    }

    const lines = text.split(/\r?\n/);
    if (lines.length > 1) {
      const partialLine = lines.pop() ?? '';
      const currentOffset = this.offsets.get(sourceLog) ?? 0;
      this.offsets.set(sourceLog, currentOffset - Buffer.byteLength(partialLine, 'utf8'));
    }
    for (const line of lines) {
      const voiceProgressLoop = voiceProgressLoopFromLine(line);
      if (voiceProgressLoop?.isSubagent) {
        const parentTurnId = this.lastRootTurnByLog.get(sourceLog);
        if (parentTurnId) this.parentTurnBySubagentRequest.set(`${sourceLog}:${voiceProgressLoop.requestId}`, parentTurnId);
      } else if (voiceProgressLoop) {
        this.lastRootTurnByLog.set(sourceLog, voiceProgressLoop.requestId);
      }
      const conversationId = conversationIdFromLine(line);
      const turnId = turnIdFromLine(line);
      const newConversationId = newConversationIdFromLine(line);
      const pendingTitle = newConversationId ? this.pendingTitles.get(sourceLog) : undefined;
      if (newConversationId && pendingTitle) {
        await this.updateChatTitle(newConversationId, pendingTitle, line.slice(0, 23));
        this.pendingTitles.delete(sourceLog);
      } else if (newConversationId) {
        const chats = this.pendingNewChats.get(sourceLog) ?? [];
        chats.push({ chatId: newConversationId, timestamp: line.slice(0, 23) });
        this.pendingNewChats.set(sourceLog, chats.slice(-10));
      }
      if (conversationId && turnId) {
        const turnKey = `${sourceLog}:${turnId}`;
        const conversationTurn = { chatId: conversationId, turnId };
        this.conversationTurns.set(turnKey, conversationTurn);
        const startedAt = timestampFromLine(line);
        if (startedAt && /\[ChatWebSocketManager\]\s+Sending request for conversation/i.test(line)) {
          const requests = this.websocketRequests.get(sourceLog) ?? [];
          requests.push({ chatId: conversationId, turnId, startedAt });
          this.websocketRequests.set(sourceLog, requests.slice(-50));
        }
        await this.resolvePendingChatRequests(turnKey, conversationId, turnId);
        await this.resolvePendingSubagentRequests(sourceLog, turnId, conversationId);
      }
      const voiceProgressRequestId = voiceProgressRequestIdFromLine(line);
      if (voiceProgressRequestId) {
        const pendingRequestIds = this.pendingChatRequests.get(`${sourceLog}:pending`);
        if (pendingRequestIds?.length) {
          const turnKey = `${sourceLog}:${voiceProgressRequestId}`;
          this.pendingChatRequests.set(turnKey, pendingRequestIds);
          this.pendingChatRequests.delete(`${sourceLog}:pending`);
          const conversationTurn = this.conversationTurns.get(turnKey);
          if (conversationTurn) {
            await this.resolvePendingChatRequests(turnKey, conversationTurn.chatId, conversationTurn.turnId);
          } else {
            const parentTurnId = this.parentTurnBySubagentRequest.get(turnKey);
            const parentTurn = parentTurnId ? this.conversationTurns.get(`${sourceLog}:${parentTurnId}`) : undefined;
            if (parentTurn) await this.resolvePendingChatRequests(turnKey, parentTurn.chatId, parentTurn.turnId);
          }
        }
      }
      const responseDuration = websocketResponseDurationFromLine(line);
      const responseAt = timestampFromLine(line);
      if (responseDuration !== undefined && responseAt !== undefined) {
        const candidates = (this.websocketRequests.get(sourceLog) ?? []).filter(request => Math.abs(responseAt - request.startedAt - responseDuration) <= 250);
        if (candidates.length === 1) this.pendingWebsocketResponses.set(sourceLog, candidates[0]);
      }
      const parsed = parseLine(line, sourceLog, conversationId, turnId);
      const request = parsed ? await readCopilotRequest(parsed.requestId) : undefined;
      const websocketResponse = parsed?.requestType === 'chat' ? this.pendingWebsocketResponses.get(sourceLog) : undefined;
      const rootTurnId = websocketResponse?.turnId ?? this.lastRootTurnByLog.get(sourceLog) ?? parsed?.turnId ?? request?.turnId;
      const generatedTitle = parsed?.feature.toLowerCase() === 'title' && isUsableConversationTitle(request?.conversationTitle) ? request.conversationTitle : undefined;
      const persistedChat = rootTurnId ? await persistedChatForTurn(this.workspaceStoragePath(), rootTurnId) : undefined;
      if (generatedTitle && persistedChat) {
        await this.updateChatTitle(persistedChat.chatId, generatedTitle, parsed?.timestamp ?? line.slice(0, 23));
      } else if (generatedTitle) {
        this.pendingTitles.set(sourceLog, generatedTitle);
      }
      if (parsed?.feature.toLowerCase() === 'title' && !generatedTitle) {
        const titles = this.pendingTitleRequests.get(sourceLog) ?? [];
        titles.push({ requestId: parsed.requestId, timestamp: parsed.timestamp, rootTurnId });
        this.pendingTitleRequests.set(sourceLog, titles.slice(-10));
        this.scheduleTitleRecovery(sourceLog);
      }
      const chatId = persistedChat?.chatId;
      const resolvedTurnId = rootTurnId;
      const record = parsed && request?.usage ? applyCopilotUsage(parsed, request.usage, chatId) : parsed;
      const conversationTitle = persistedChat?.title;
      const toolMetadata = request?.toolNames?.length ? { toolNames: request.toolNames, toolCallCount: request.toolCallCount } : {};
      const enrichedRecord = record ? { ...record, schemaId: usageSchemaId, ...(chatId ? { chatId } : {}), ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}), ...(conversationTitle ? { conversationTitle, conversationTitleSource: persistedChat?.titleSource } : {}), ...(persistedChat?.firstUserMessage ? { firstUserMessage: persistedChat.firstUserMessage } : {}), ...toolMetadata } : record;
      if (websocketResponse) this.pendingWebsocketResponses.delete(sourceLog);
      if (enrichedRecord && requestTypeOf(enrichedRecord) === 'chat' && !enrichedRecord.chatId) {
        const pendingKey = `${sourceLog}:pending`;
        this.pendingChatRequests.set(pendingKey, [...(this.pendingChatRequests.get(pendingKey) ?? []), enrichedRecord.requestId]);
        setTimeout(() => void this.reconcileStoredRecords(), 500);
      }
      if (enrichedRecord && !this.seen.has(enrichedRecord.requestId)) {
        this.seen.add(enrichedRecord.requestId);
        await this.append(enrichedRecord);
      }
    }
  }

  private async resolvePendingChatRequests(key: string, chatId: string, turnId: string): Promise<void> {
    const requestIds = this.pendingChatRequests.get(key);
    if (!requestIds?.length) return;
    this.pendingChatRequests.delete(key);
    for (const requestId of requestIds) {
      await this.updateRecordChatMetadata(requestId, chatId, turnId);
    }
  }

  private async resolvePendingSubagentRequests(sourceLog: string, parentTurnId: string, chatId: string): Promise<void> {
    for (const [subagentKey, mappedParentTurnId] of this.parentTurnBySubagentRequest) {
      if (mappedParentTurnId !== parentTurnId) continue;
      const requestIds = this.pendingChatRequests.get(subagentKey);
      if (requestIds?.length) await this.resolvePendingChatRequests(subagentKey, chatId, parentTurnId);
    }
  }

  private async updateRecordChatMetadata(requestId: string, chatId: string, turnId: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const output = path.join(folder.uri.fsPath, usageDirectory, usageFileName);
    let content: string;
    try {
      content = await fs.readFile(output, 'utf8');
    } catch {
      return;
    }
    let changed = false;
    const updated = content.split(/\r?\n/).map(line => {
      try {
        const record = JSON.parse(line) as UsageRecord;
        if (record.requestId !== requestId || record.chatId === chatId && record.turnId === turnId) return line;
        changed = true;
        return JSON.stringify({ ...record, chatId, turnId, schemaId: usageSchemaId });
      } catch {
        return line;
      }
    });
    if (!changed) return;
    await fs.writeFile(output, updated.join('\n'), 'utf8');
    const record = updated.flatMap(line => {
      try {
        const value = JSON.parse(line) as UsageRecord;
        return value.requestId === requestId ? [value] : [];
      } catch {
        return [];
      }
    })[0];
    if (record) {
      await updateChatMetadata(record);
      if (record.chatId) await this.updatePersistedChatTitle(record.chatId, record.timestamp, record.turnId ? [record.turnId] : []);
    }
    await this.onRecord();
  }

  private async updateChatTitle(chatId: string, title: string, timestamp: string, titleSource: 'copilot' | 'firstUserMessage' = 'copilot'): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return false;
    const metadataPath = path.join(folder.uri.fsPath, usageDirectory, usageMetadataFileName);
    const chats = await readChatMetadata();
    const existing = chats.find(chat => chat.chatId === chatId);
    if (existing?.titleSource === 'copilot' && titleSource !== 'copilot') return false;
    if (existing?.title === title) return false;
    const titleHistory = existing?.titleHistory ?? (existing?.title ? [{ title: existing.title, observedAt: existing.firstSeen }] : []);
    if (titleHistory[titleHistory.length - 1]?.title !== title) titleHistory.push({ title, observedAt: timestamp });
    const metadata: ChatMetadata = {
      chatId,
      title,
      titleSource,
      titleHistory,
      turnIds: existing?.turnIds ?? [],
      firstSeen: existing?.firstSeen ?? timestamp,
      lastSeen: existing?.lastSeen ?? timestamp
    };
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(metadataPath, `${JSON.stringify({ schemaId: usageMetadataSchemaId, chats: [...chats.filter(chat => chat.chatId !== chatId), metadata] }, null, 2)}\n`, 'utf8');
    return true;
  }

  private scheduleTitleRecovery(sourceLog: string): void {
    setTimeout(() => void this.recoverPendingTitles(sourceLog, 3), 500);
  }

  private async recoverPendingTitles(sourceLog: string, attemptsRemaining: number): Promise<void> {
    const titles = this.pendingTitleRequests.get(sourceLog) ?? [];
    const chats = this.pendingNewChats.get(sourceLog) ?? [];
    if (!titles.length || !chats.length) return;
    const remainingTitles: { requestId: string; timestamp: string; rootTurnId?: string }[] = [];
    for (const pendingTitle of titles) {
      const title = (await readCopilotRequest(pendingTitle.requestId))?.conversationTitle;
      const persistedChat = pendingTitle.rootTurnId
        ? await persistedChatForTurn(this.workspaceStoragePath(), pendingTitle.rootTurnId)
        : undefined;
      if (isUsableConversationTitle(title) && persistedChat) {
        await this.updateChatTitle(persistedChat.chatId, title, pendingTitle.timestamp);
        continue;
      }
      const chat = chats.find(candidate => candidate.timestamp >= pendingTitle.timestamp);
      if (isUsableConversationTitle(title) && chat) {
        const changed = await this.updateChatTitle(chat.chatId, title, pendingTitle.timestamp);
        if (changed) await this.onRecord();
        this.pendingNewChats.set(sourceLog, (this.pendingNewChats.get(sourceLog) ?? []).filter(candidate => candidate !== chat));
      } else {
        remainingTitles.push(pendingTitle);
      }
    }
    this.pendingTitleRequests.set(sourceLog, remainingTitles);
    if (remainingTitles.length && attemptsRemaining > 1) {
      setTimeout(() => void this.recoverPendingTitles(sourceLog, attemptsRemaining - 1), 1000);
    }
  }

  private async append(record: UsageRecord): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const output = path.join(folder.uri.fsPath, usageDirectory, usageFileName);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.appendFile(output, `${JSON.stringify(record)}\n`, 'utf8');
    await updateChatMetadata(record);
    if (record.chatId) await this.updatePersistedChatTitle(record.chatId, record.timestamp, record.turnId ? [record.turnId] : []);
    await this.onRecord(record);
    this.status.text = record.costUsd === null ? '$(pulse) Copilot usage ?' : `$(pulse) Copilot $${formatDecimal(record.costUsd)}`;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.status.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const report = new UsageReportProvider(await loadReportTemplates(context.extensionUri.fsPath));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('copilotCostCounter.report', report));
  const collector = new UsageCollector(context, async record => {
    await report.refresh();
    if (record) report.showMoneyBurn(record.costUsd);
  });
  const refreshReport = async (): Promise<void> => {
    await collector.refresh();
    await report.refresh();
  };
  report.setRefreshLog(refreshReport);
  context.subscriptions.push(vscode.commands.registerCommand('copilotCostCounter.refreshReport', refreshReport));
  context.subscriptions.push(vscode.commands.registerCommand('copilotCostCounter.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.copilot-cost-counter')));
  context.subscriptions.push(collector);
  context.subscriptions.push(vscode.commands.registerCommand('copilotCostCounter.openUsage', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(folder.uri.fsPath, usageDirectory, usageFileName)));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('copilotCostCounter.chooseLog', async () => {
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use Copilot log', filters: { 'Log files': ['log', 'txt'], 'All files': ['*'] } });
    if (selected?.[0]) await vscode.workspace.getConfiguration('copilotCostCounter').update('logPath', selected[0].fsPath, vscode.ConfigurationTarget.Workspace);
  }));
  await collector.start();
}

export function deactivate(): void {}
