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
    this.view.webview.html = renderReport(await readUsageRecords(), this.view.webview);
  }

  showMoneyBurn(costUsd: number | null): void {
    if (!this.view || costUsd === null || costUsd <= 0) return;
    const enabled = vscode.workspace.getConfiguration('copilotCostCounter').get<boolean>('showMoneyBurn', false);
    if (enabled) void this.view.webview.postMessage({ type: 'moneyBurn', amount: formatMoney(costUsd) });
  }
}

function renderReport(records: ReportRecord[], webview: vscode.Webview): string {
  const nonce = createNonce();
  const billableRecords = records.filter(record => requestTypeOf(record) !== 'utility');
  const estimated = billableRecords.filter(record => record.costKind === 'estimated' && record.costUsd !== null);
  const totalUsd = estimated.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  const totalCredits = estimated.reduce((sum, record) => sum + (record.aiCredits ?? 0), 0);
  const tokenTotals = records.reduce((totals, record) => ({
    prompt: totals.prompt + (record.promptTokens ?? 0),
    input: totals.input + (record.freshInputTokens ?? 0),
    output: totals.output + (record.outputTokens ?? 0),
    cache: totals.cache + (record.cacheTokens ?? 0),
    cacheWrite: totals.cacheWrite + (record.cacheWriteTokens ?? 0)
  }), { prompt: 0, input: 0, output: 0, cache: 0, cacheWrite: 0 });
  const tokenRecords = records.filter(record => record.promptTokens !== null || record.outputTokens !== null || record.cacheTokens !== null || record.cacheWriteTokens !== null).length;
  const unavailableCount = 0;
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
  const dailyBars = [...byDay.entries()].slice(-14).map(([day, cost]) => `<div class="bar-group"><div class="bar" style="height:${Math.max(4, cost / maxDay * 100)}%" title="${escapeHtml(day)}: ${formatMoney(cost)}"></div><span>${escapeHtml(day.slice(5))}</span></div>`).join('');
  const modelBars = [...byModel.entries()].sort((left, right) => right[1].cost - left[1].cost).slice(0, 6).map(([model, value]) => `<div class="model-row"><div class="model-label"><span>${escapeHtml(model)}</span><strong>${formatMoney(value.cost)}</strong></div><div class="track"><div class="fill" style="width:${value.cost / maxModel * 100}%"></div></div><small>${value.requests} request${value.requests === 1 ? '' : 's'}</small></div>`).join('');
  const recent = records.slice(-8).reverse().map(record => `<tr style="${requestTypeOf(record) === 'utility' ? 'opacity:.55' : ''}"><td>${escapeHtml(record.timestamp.replace('T', ' ').slice(0, 16))}</td><td>${escapeHtml(record.model)}<br><small>${escapeHtml(requestTypeLabel(record))}</small></td><td>${record.costUsd === null ? formatUnavailable(record) : formatMoney(record.costUsd)}</td><td>${record.aiCredits === null ? formatUnavailable(record) : formatDecimal(record.aiCredits)}</td></tr>`).join('');
  const creditCards = `<div class="card"><span>Estimated spend</span><strong>${formatMoney(totalUsd)}</strong></div><div class="card"><span>AI credits</span><strong>${formatDecimal(totalCredits)}</strong></div><div class="card"><span>Requests</span><strong>${records.length}</strong></div><div class="card"><span>Cost available</span><strong>${estimated.length} / ${billableRecords.length}</strong></div><script nonce="${nonce}">window.addEventListener('DOMContentLoaded',()=>{document.querySelector('.actions')?.remove();const recentHeader=document.querySelector('table thead tr');if(recentHeader){const creditHeader=document.createElement('th');creditHeader.textContent='AI credits';recentHeader.appendChild(creditHeader);}document.querySelectorAll('table th,table td').forEach(cell=>{cell.style.padding='4px 6px';});});window.addEventListener('message',event=>{if(event.data?.type!=='moneyBurn')return;const burst=document.createElement('div');burst.textContent=event.data.amount;burst.style.cssText='position:fixed;right:18px;bottom:18px;z-index:10;color:var(--vscode-charts-red);font-size:18px;font-weight:700;pointer-events:none;text-shadow:0 1px 2px var(--vscode-widget-shadow);';document.body.appendChild(burst);const animation=burst.animate([{transform:'translateY(0) scale(1)',opacity:1},{transform:'translateY(-48px) scale(1.08)',opacity:0}],{duration:900,easing:'ease-out'});animation.finished.then(()=>burst.remove(),()=>burst.remove());});</script>`;
  const tokenCards = `<div class="card"><span>Requests</span><strong>${records.length}</strong></div><div class="card"><span>Tokens recorded</span><strong>${tokenRecords} / ${records.length}</strong></div><div class="card"><span>Input tokens</span><strong>${tokenTotals.input.toLocaleString()}</strong></div><div class="card"><span>Output tokens</span><strong>${tokenTotals.output.toLocaleString()}</strong></div><div class="card"><span>Cached tokens</span><strong>${tokenTotals.cache.toLocaleString()}</strong></div><div class="card"><span>Cache-write tokens</span><strong>${tokenTotals.cacheWrite.toLocaleString()}</strong></div>`;
  const missingPricingNotice = missingPriceModels.length ? `<div class="notice" data-notice="pricing"><span>Missing token prices for ${missingPriceModels.map(escapeHtml).join(', ')}. Set input and output rates in <code>copilotCostCounter.modelPricingOverrides</code> to calculate costs for new requests.</span><button class="dismiss" aria-label="Dismiss">&times;</button><script nonce="${nonce}">const notice=document.currentScript?.parentElement;if(notice&&localStorage.getItem('copilotCostCounter.dismissedPricingNotice')==='1')notice.remove();notice?.querySelector('.dismiss')?.addEventListener('click',()=>localStorage.setItem('copilotCostCounter.dismissedPricingNotice','1'));</script></div>` : '';
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
    :root { color-scheme: light dark; } * { box-sizing: border-box; } body { padding: 14px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 12px; } h1 { font-size: 18px; margin: 0; } h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin: 22px 0 10px; color: var(--vscode-descriptionForeground); } .subtle { color: var(--vscode-descriptionForeground); margin: 4px 0 16px; } .actions { display: flex; gap: 6px; margin-bottom: 14px; } button { border: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 6px 9px; cursor: pointer; } button:hover { background: var(--vscode-button-hoverBackground); } .notice { display: flex; align-items: flex-start; gap: 8px; border-left: 3px solid var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); padding: 8px; margin: 0 0 12px; } .notice > span { flex: 1; min-width: 0; } .dismiss { flex: 0 0 auto; border: 0; background: transparent; color: var(--vscode-descriptionForeground); padding: 0 2px; font-size: 16px; line-height: 1; } .dismiss:hover { color: var(--vscode-foreground); background: transparent; } code { font-family: var(--vscode-editor-font-family); } .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); margin: 4px 0 16px; } .mode { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--vscode-descriptionForeground); padding: 7px 12px 6px; margin-bottom: -1px; } .mode:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); } .mode.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); background: transparent; font-weight: 600; } .mode-panel[hidden] { display: none; } .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; } .card { border: 1px solid var(--vscode-widget-border); padding: 10px; min-width: 0; } .card strong { display: block; font-size: 16px; margin-top: 4px; overflow-wrap: anywhere; } .card span { color: var(--vscode-descriptionForeground); } .chart { height: 160px; display: flex; align-items: stretch; gap: 5px; border-bottom: 1px solid var(--vscode-widget-border); padding: 8px 2px 0; } .bar-group { position: relative; flex: 1; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; min-width: 0; padding-bottom: 28px; } .bar { width: 100%; max-width: 18px; min-height: 4px; background: var(--vscode-charts-blue); } .bar-group span { position: absolute; bottom: 5px; width: 100%; font-size: 9px; color: var(--vscode-descriptionForeground); text-align: center; white-space: nowrap; } .model-row { margin: 9px 0; } .model-label { display: flex; justify-content: space-between; gap: 8px; } .model-label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .track { height: 5px; background: var(--vscode-editorWidget-background); margin: 4px 0; } .fill { height: 100%; background: var(--vscode-charts-green); } small, .muted { color: var(--vscode-descriptionForeground); } table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 3px; border-bottom: 1px solid var(--vscode-widget-border); } th { color: var(--vscode-descriptionForeground); font-weight: normal; } td:nth-child(1) { white-space: nowrap; } .empty { color: var(--vscode-descriptionForeground); padding: 12px 0; }
  </style></head><body><h1>Usage Report</h1><p class="subtle">Workspace-local Copilot activity</p><div class="actions"><button id="refresh">Refresh</button><button id="open">Open JSONL</button></div>${missingPricingNotice}${unavailableCount ? '<div class="notice" data-notice="unavailable"><span>Token usage is not present in the Copilot log, so costs are unavailable. Request counts are still recorded.</span><button class="dismiss" aria-label="Dismiss">&times;</button></div>' : ''}<div class="tabs" role="tablist"><button class="mode active" role="tab" aria-selected="true" data-mode="credits">Credits</button><button class="mode" role="tab" aria-selected="false" data-mode="tokens">Tokens</button></div><section class="mode-panel" data-panel="credits"><div class="cards">${creditCards}</div><h2>Daily spend</h2>${dailyBars ? `<div class="chart">${dailyBars}</div>` : '<div class="empty">No estimated cost data yet.</div>'}<h2>By model</h2>${modelBars || '<div class="empty">No model cost data yet.</div>'}</section><section class="mode-panel" data-panel="tokens" hidden><div class="cards">${tokenCards}</div><p class="subtle">Prompt: ${tokenTotals.prompt.toLocaleString()} | Fresh input: ${tokenTotals.input.toLocaleString()} | Output: ${tokenTotals.output.toLocaleString()} | Cached: ${tokenTotals.cache.toLocaleString()} | Cache write: ${tokenTotals.cacheWrite.toLocaleString()}</p></section><h2>Recent requests</h2>${recent ? `<table><thead><tr><th>Time</th><th>Model</th><th>Cost</th></tr></thead><tbody>${recent}</tbody></table>` : '<div class="empty">No usage records yet.</div>'}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.getElementById('open').addEventListener('click',()=>vscode.postMessage({type:'openUsage'}));document.querySelectorAll('.dismiss').forEach(button=>button.addEventListener('click',()=>button.closest('.notice').remove()));document.querySelectorAll('.mode').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.mode').forEach(item=>{const active=item===button;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});document.querySelectorAll('.mode-panel').forEach(panel=>panel.hidden=panel.dataset.panel!==button.dataset.mode)}));</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
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
  const report = new UsageReportProvider();
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
