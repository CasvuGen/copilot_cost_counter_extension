import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import generatedPricing from './pricing.generated.json';

const usageDirectory = '.copilot';
const usageFileName = 'usage.jsonl';
const pricingSource = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';

type ModelPricing = { input: number; cachedInput?: number; cacheWrite?: number; output: number };
type GeneratedPricingRow = { model: string; tier: string; since: string; input: number; cachedInput?: number; cacheWrite?: number; output: number };
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

function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]+\]/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

function numberFromLine(line: string, names: string[]): number | undefined {
  const namePattern = names.join('|');
  const match = line.match(new RegExp(`(?:${namePattern})[=:]\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : undefined;
}

function parseLine(line: string, sourceLog: string): UsageRecord | undefined {
  const match = line.match(/ccreq:([^ ]+)\s+\|\s+(success|cancelled|failed)\s+\|\s+([^|]+?)\s+\|\s+(\d+)ms\s+\|\s+\[([^\]]+)\]/i);
  if (!match || match[2].toLowerCase() !== 'success') {
    return undefined;
  }

  const model = match[3].trim();
  const promptTokens = numberFromLine(line, ['prompt_tokens', 'promptTokenCount', 'input_tokens']) ?? null;
  const outputTokens = numberFromLine(line, ['completion_tokens', 'responseTokenCount', 'output_tokens']) ?? null;
  const cacheTokens = numberFromLine(line, ['cached_tokens', 'cacheTokens']) ?? null;
  const cacheWriteTokens = numberFromLine(line, ['cache_write_tokens', 'cacheWriteTokens']) ?? null;
  const modelPricing = pricing[normalizeModel(model)];
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

class UsageCollector implements vscode.Disposable {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seen = new Set<string>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status.command = 'copilotCostCounter.openUsage';
    this.status.text = '$(pulse) Copilot usage';
    this.status.tooltip = 'Open Copilot usage records';
    this.status.show();
  }

  async start(): Promise<void> {
    await this.poll();
    this.schedule();
  }

  private schedule(): void {
    const interval = vscode.workspace.getConfiguration('copilotCostCounter').get('pollIntervalMs', 1000);
    this.timer = setInterval(() => void this.poll(), interval);
  }

  private async logPath(): Promise<string | undefined> {
    const configured = vscode.workspace.getConfiguration('copilotCostCounter').get<string>('logPath', '').trim();
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', configured);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, 'usage.log') : undefined;
  }

  private async poll(): Promise<void> {
    const sourceLog = await this.logPath();
    if (!sourceLog) return;
    let text: string;
    try {
      const stat = await fs.stat(sourceLog);
      if (stat.size < this.offset) this.offset = 0;
      text = (await fs.readFile(sourceLog, 'utf8')).slice(this.offset);
      this.offset += Buffer.byteLength(text, 'utf8');
    } catch {
      return;
    }

    const lines = text.split(/\r?\n/);
    if (lines.length > 1) this.offset -= Buffer.byteLength(lines.pop() ?? '', 'utf8');
    for (const line of lines) {
      const record = parseLine(line, sourceLog);
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
    this.status.text = record.costUsd === null ? '$(pulse) Copilot usage ?' : `$(pulse) Copilot $${record.costUsd.toFixed(4)}`;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.status.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const collector = new UsageCollector(context);
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
