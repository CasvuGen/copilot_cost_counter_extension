import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import generatedPricing from './pricing.generated.json';

const usageDirectory = '.copilot';
const usageFileName = 'usage.jsonl';
const usageSchemaId = 4;
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
  pricingSource: string;
  pricingUpdatedAt: string | null;
  costKind: 'estimated' | 'unavailable';
};

type ReportRecord = Pick<UsageRecord, 'schemaId' | 'timestamp' | 'requestId' | 'chatId' | 'turnId' | 'conversationTitle' | 'toolNames' | 'toolCallCount' | 'model' | 'feature' | 'requestType' | 'durationMs' | 'promptTokens' | 'freshInputTokens' | 'outputTokens' | 'cacheTokens' | 'cacheWriteTokens' | 'inputRateUsdPerMillion' | 'outputRateUsdPerMillion' | 'aiCredits' | 'costUsd' | 'costKind'>;
type CopilotUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  copilot_usage?: { total_nano_aiu?: number };
};
type CopilotRequest = { usage?: CopilotUsage; chatId?: string; turnId?: string; conversationTitle?: string; toolNames?: string[]; toolCallCount?: number };
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

function classifyRequestType(feature: string): RequestType {
  const normalized = feature.toLowerCase();
  if (/next.?edit|\bnes\b/.test(normalized)) return 'nextEditSuggestion';
  if (/inline|completion/.test(normalized)) return 'completion';
  if (/progressmessages|copilotlanguagemodelwrapper|backgroundtodo|tool|summarizeconversation|xtabprovider|healapplypatch|title/.test(normalized)) return 'utility';
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
  const match = line.match(/(?:turn(?:Id|_id)?|userTurnId)[\s:=]+([0-9a-f]{8}-[0-9a-f-]{27,})/i);
  return match?.[1];
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
    pricingSource,
    pricingUpdatedAt,
    costKind: costUsd === null ? 'unavailable' : 'estimated'
  };
}

function applyCopilotUsage(record: UsageRecord, usage: CopilotUsage, chatId = record.chatId): UsageRecord {
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : record.promptTokens;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : record.outputTokens;
  const cacheTokens = typeof usage.prompt_tokens_details?.cached_tokens === 'number' ? usage.prompt_tokens_details.cached_tokens : record.cacheTokens;
  const cacheWriteTokens = typeof usage.prompt_tokens_details?.cache_write_tokens === 'number' ? usage.prompt_tokens_details.cache_write_tokens : record.cacheWriteTokens;
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
    const chatId = findStringByKey(value, new Set(['conversationid', 'chatid']))
      ?? findStringByKey(value, new Set(['sessionid']));
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
    this.view.webview.html = renderReportFromTemplates(await readUsageRecords(), this.templates);
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

function renderReportFromTemplates(records: ReportRecord[], templates: ReportTemplates): string {
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
  for (const record of records) {
    if (record.chatId && record.conversationTitle && !conversationTitles.has(record.chatId)) conversationTitles.set(record.chatId, record.conversationTitle);
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
  for (const record of records) {
    const key = record.chatId ?? 'unavailable';
    const group = chats.get(key) ?? [];
    group.push(record);
    chats.set(key, group);
  }
  const chatGroups = [...chats.entries()].sort((left, right) => right[1][right[1].length - 1].timestamp.localeCompare(left[1][left[1].length - 1].timestamp)).slice(0, 20).map(([key, chatRecords]) => {
    const estimatedChatCost = chatRecords.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    const conversationTitle = chatRecords.find(record => record.conversationTitle)?.conversationTitle;
    const title = conversationTitle ?? (key === 'unavailable' ? 'Older requests without chat metadata' : `Chat ${key.slice(0, 12)}`);
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
  const recentChats = chatGroups ? fillTemplate(templates.chatTable, { groups: chatGroups }) : empty('No chat data available.');
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
    await this.reconcileStoredRecords();
    await this.poll();
    this.schedule();
  }

  async refresh(): Promise<void> {
    await this.reconcileStoredRecords();
    await this.poll();
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
    let changed = false;
    const updated = await Promise.all(lines.map(async line => {
      if (!line) return line;
      try {
        const record = JSON.parse(line) as UsageRecord;
        let updated = record;
        let recordChanged = false;
        if (record.schemaId !== usageSchemaId) {
          updated = { ...updated, schemaId: usageSchemaId };
          recordChanged = true;
        }
        if (!record.requestType) {
          updated = { ...updated, requestType: classifyRequestType(record.feature) };
          recordChanged = true;
        }
        const request = await readCopilotRequest(updated.requestId);
        if (!request) {
          changed = changed || recordChanged;
          return recordChanged ? JSON.stringify(updated) : line;
        }
        if (request.chatId && updated.chatId !== request.chatId) {
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
        if (updated.costUsd !== null || !request.usage) {
          changed = changed || recordChanged;
          return recordChanged ? JSON.stringify(updated) : line;
        }
        changed = true;
        return JSON.stringify({ ...applyCopilotUsage(updated, request.usage, request.chatId), schemaId: usageSchemaId });
      } catch {
        return line;
      }
    }));
    if (changed) {
      await fs.writeFile(output, updated.join('\n'), 'utf8');
      await this.onRecord();
    }
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
      this.offsets.clear();
    }
  }

  private async pollLog(sourceLog: string): Promise<void> {
    let text: string;
    try {
      const stat = await fs.stat(sourceLog);
      const offset = this.offsets.get(sourceLog) ?? 0;
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
      const parsed = parseLine(line, sourceLog, conversationIdFromLine(line), turnIdFromLine(line));
      const request = parsed ? await readCopilotRequest(parsed.requestId) : undefined;
      const chatId = request?.chatId ?? parsed?.chatId;
      const resolvedTurnId = request?.turnId ?? parsed?.turnId;
      const record = parsed && request?.usage ? applyCopilotUsage(parsed, request.usage, chatId) : parsed;
      const conversationTitle = parsed?.feature.toLowerCase() === 'title' ? request?.conversationTitle : undefined;
      const toolMetadata = request?.toolNames?.length ? { toolNames: request.toolNames, toolCallCount: request.toolCallCount } : {};
      const enrichedRecord = record ? { ...record, schemaId: usageSchemaId, ...(chatId ? { chatId } : {}), ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}), ...(conversationTitle ? { conversationTitle } : {}), ...toolMetadata } : record;
      if (enrichedRecord && !this.seen.has(enrichedRecord.requestId)) {
        this.seen.add(enrichedRecord.requestId);
        await this.append(enrichedRecord);
      }
    }
  }

  private async append(record: UsageRecord): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const output = path.join(folder.uri.fsPath, usageDirectory, usageFileName);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.appendFile(output, `${JSON.stringify(record)}\n`, 'utf8');
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
