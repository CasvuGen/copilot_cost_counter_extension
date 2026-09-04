import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import generatedPricing from './pricing.generated.json';

const usageDirectory = '.copilot';
const usageFileName = 'usage.jsonl';
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
  timestamp: string;
  sourceLog: string;
  requestId: string;
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

type ReportRecord = Pick<UsageRecord, 'timestamp' | 'requestId' | 'model' | 'feature' | 'requestType' | 'durationMs' | 'promptTokens' | 'freshInputTokens' | 'outputTokens' | 'cacheTokens' | 'cacheWriteTokens' | 'inputRateUsdPerMillion' | 'outputRateUsdPerMillion' | 'aiCredits' | 'costUsd' | 'costKind'>;
type CopilotUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
type ReportTemplates = {
  report: string;
  card: string;
  dailyBar: string;
  dailyChart: string;
  modelRow: string;
  recentRow: string;
  recentTable: string;
  pricingNotice: string;
  empty: string;
};

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

async function loadReportTemplates(extensionPath: string): Promise<ReportTemplates> {
  const templatePath = (name: string) => path.join(extensionPath, 'templates', name);
  const [report, card, dailyBar, dailyChart, modelRow, recentRow, recentTable, pricingNotice, empty] = await Promise.all([
    fs.readFile(templatePath('report.html'), 'utf8'),
    fs.readFile(templatePath('card.html'), 'utf8'),
    fs.readFile(templatePath('daily-bar.html'), 'utf8'),
    fs.readFile(templatePath('daily-chart.html'), 'utf8'),
    fs.readFile(templatePath('model-row.html'), 'utf8'),
    fs.readFile(templatePath('recent-row.html'), 'utf8'),
    fs.readFile(templatePath('recent-table.html'), 'utf8'),
    fs.readFile(templatePath('pricing-notice.html'), 'utf8'),
    fs.readFile(templatePath('empty.html'), 'utf8')
  ]);
  return { report, card, dailyBar, dailyChart, modelRow, recentRow, recentTable, pricingNotice, empty };
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
  return displayNumber.format(Math.floor(value * 10) / 10);
}

function formatMoney(valueUsd: number): string {
  const configuration = vscode.workspace.getConfiguration('copilotCostCounter');
  const currency = configuration.get<string>('currency', 'USD');
  const conversionRate = configuration.get<number>('currencyConversionRate', 1);
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.floor(valueUsd * conversionRate * 10) / 10);
}

function formatRecentMoney(valueUsd: number): string {
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

function parseLine(line: string, sourceLog: string): UsageRecord | undefined {
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
    timestamp: line.slice(0, 23),
    sourceLog,
    requestId: match[1],
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

function applyCopilotUsage(record: UsageRecord, usage: CopilotUsage): UsageRecord {
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
  const costUsd = inputCostUsd !== null && outputCostUsd !== null ? inputCostUsd + outputCostUsd + (cacheCostUsd ?? 0) + (cacheWriteCostUsd ?? 0) : null;
  return {
    ...record,
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
    aiCredits: costUsd === null ? null : costUsd / .01,
    costKind: costUsd === null ? 'unavailable' : 'estimated'
  };
}

async function readCopilotUsage(requestId: string): Promise<CopilotUsage | undefined> {
  try {
    const canonicalRequestId = requestId.replace(/\.copilotmd$/i, '');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(`ccreq:${canonicalRequestId}.json`));
    const value = JSON.parse(document.getText()) as { metadata?: { usage?: CopilotUsage } };
    return value.metadata?.usage;
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
        const record = JSON.parse(line) as ReportRecord;
        return typeof record.requestId === 'string' ? [record] : [];
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
    const durationMs = Math.max(100, Math.min(10000, configuration.get<number>('moneyBurnDurationMs', 900)));
    const sizePx = Math.max(8, Math.min(72, configuration.get<number>('moneyBurnSizePx', 18)));
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
  const byModel = new Map<string, { cost: number; requests: number }>();
  for (const record of estimated) {
    const day = record.timestamp.slice(0, 10) || 'Unknown';
    byDay.set(day, (byDay.get(day) ?? 0) + (record.costUsd ?? 0));
    const model = byModel.get(record.model) ?? { cost: 0, requests: 0 };
    model.cost += record.costUsd ?? 0;
    model.requests += 1;
    byModel.set(record.model, model);
  }
  const maxDay = Math.max(...byDay.values(), 0.000001);
  const maxModel = Math.max(...[...byModel.values()].map(model => model.cost), 0.000001);
  const empty = (message: string) => fillTemplate(templates.empty, { message: escapeHtml(message) });
  const card = (label: string, value: string) => fillTemplate(templates.card, { label: escapeHtml(label), value: escapeHtml(value) });
  const dailySpend = byDay.size ? fillTemplate(templates.dailyChart, { bars: [...byDay.entries()].slice(-14).map(([day, cost]) => fillTemplate(templates.dailyBar, {
    height: String(Math.max(4, cost / maxDay * 100)), title: escapeHtml(`${day}: ${formatMoney(cost)}`), day: escapeHtml(day.slice(5))
  })).join('') }) : empty('No estimated cost data yet.');
  const modelBreakdown = byModel.size ? [...byModel.entries()].sort((left, right) => right[1].cost - left[1].cost).slice(0, 6).map(([model, value]) => fillTemplate(templates.modelRow, {
    model: escapeHtml(model), cost: escapeHtml(formatMoney(value.cost)), width: String(value.cost / maxModel * 100), requests: String(value.requests), plural: value.requests === 1 ? '' : 's'
  })).join('') : empty('No model cost data yet.');
  const rows = records.slice(-8).reverse().map(record => fillTemplate(templates.recentRow, {
    style: requestTypeOf(record) === 'utility' ? 'opacity:.55' : '', timestamp: escapeHtml(record.timestamp.replace('T', ' ').slice(0, 16)), model: escapeHtml(record.model),
    requestType: escapeHtml(requestTypeLabel(record)), cost: record.costUsd === null ? formatUnavailable(record) : formatRecentMoney(record.costUsd), credits: record.aiCredits === null ? formatUnavailable(record) : formatDecimal(record.aiCredits)
  })).join('');
  const recentRequests = rows ? fillTemplate(templates.recentTable, { rows }) : empty('No usage records yet.');
  const missingPricingNotice = missingPriceModels.length ? fillTemplate(templates.pricingNotice, { nonce, models: missingPriceModels.map(escapeHtml).join(', ') }) : '';
  return fillTemplate(templates.report, {
    nonce, missingPricingNotice,
    creditCards: [card('Estimated spend', formatMoney(totalUsd)), card('Credits', formatDecimal(totalCredits)), card('Requests', String(records.length)), card('Cost available', `${estimated.length} / ${billableRecords.length}`)].join(''),
    dailySpend, modelBreakdown,
    tokenCards: [card('Requests', String(records.length)), card('Tokens recorded', `${tokenRecords} / ${records.length}`), card('Input tokens', tokenTotals.input.toLocaleString()), card('Output tokens', tokenTotals.output.toLocaleString()), card('Cached tokens', tokenTotals.cache.toLocaleString()), card('Cache-write tokens', tokenTotals.cacheWrite.toLocaleString())].join(''),
    tokenSummary: `Prompt: ${tokenTotals.prompt.toLocaleString()} | Fresh input: ${tokenTotals.input.toLocaleString()} | Output: ${tokenTotals.output.toLocaleString()} | Cached: ${tokenTotals.cache.toLocaleString()} | Cache write: ${tokenTotals.cacheWrite.toLocaleString()}`,
    recentRequests
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
        if (!record.requestType) {
          updated = { ...record, requestType: classifyRequestType(record.feature) };
          changed = true;
        }
        if (updated.costUsd !== null) return changed ? JSON.stringify(updated) : line;
        const usage = await readCopilotUsage(updated.requestId);
        if (!usage) return changed ? JSON.stringify(updated) : line;
        changed = true;
        return JSON.stringify(applyCopilotUsage(updated, usage));
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
      const parsed = parseLine(line, sourceLog);
      const usage = parsed ? await readCopilotUsage(parsed.requestId) : undefined;
      const record = parsed && usage ? applyCopilotUsage(parsed, usage) : parsed;
      if (record && !this.seen.has(record.requestId)) {
        this.seen.add(record.requestId);
        await this.append(record);
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
