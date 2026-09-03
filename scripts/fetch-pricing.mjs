import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing';
const since = new Date().toISOString().slice(0, 10);
const response = await fetch(source);
if (!response.ok) throw new Error(`Pricing request failed: ${response.status}`);
const html = await response.text();

function clean(value) {
  return value.replace(/<[^>]+>/g, '').replace(/&(?:nbsp|le|gt);/g, match => ({ '&nbsp;': ' ', '&le;': '<=', '&gt;': '>' }[match])).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function money(value) {
  const match = value.match(/\$\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}

const rows = [];
for (const match of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
  const table = match[0];
  const preceding = html.slice(0, match.index);
  const headings = [...preceding.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)];
  const provider = headings.length ? clean(headings.at(-1)[1]) : 'Unknown';
  const header = clean(table.match(/<tr[\s\S]*?<\/tr>/i)?.[0] ?? '');
  const columns = header.toLowerCase().includes('cache write') ? 'extended' : 'basic';
  for (const rowMatch of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => clean(cell[1]));
    if (cells.length < 4 || !cells[0] || /^model$/i.test(cells[0])) continue;
    const prices = cells.map(money).filter(value => value !== undefined);
    if (prices.length < 3) continue;
    const model = cells[0].replace(/\[[^\]]+\]/g, '').trim();
    const tier = cells.find(value => /default|long context/i.test(value)) ?? 'Default';
    const threshold = cells.find(value => /(?:<=|≤|>=|≥|>|<)\s*\d+K|not applicable/i.test(value)) ?? 'Not applicable';
    const entry = columns === 'extended' && prices.length >= 4
      ? { provider, model, tier, threshold, input: prices[0], cachedInput: prices[1], cacheWrite: prices[2], output: prices[3] }
      : { provider, model, tier, threshold, input: prices[0], cachedInput: prices[1], output: prices[2] };
    rows.push(entry);
  }
}

const currentRows = [...new Map(rows.map(row => [`${row.provider}|${row.model}|${row.tier}|${row.threshold}`, row])).values()];
if (currentRows.length < 5) throw new Error(`Only found ${currentRows.length} pricing rows; refusing to generate fallback data`);

let previousRows = [];
try {
  previousRows = JSON.parse(await readFile(new URL('../src/pricing.generated.json', import.meta.url), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const key = row => `${row.provider}|${row.model}|${row.tier}|${row.threshold}`;
const priceFields = ['input', 'cachedInput', 'cacheWrite', 'output'];
const samePrices = (left, right) => priceFields.every(field => (left[field] ?? null) === (right[field] ?? null));
const history = previousRows.map(row => ({ ...row, since: row.since ?? since }));
const latestByKey = new Map();
for (const row of history) latestByKey.set(key(row), row);
for (const row of currentRows) {
  const previous = latestByKey.get(key(row));
  if (!previous || !samePrices(previous, row)) {
    const next = { ...row, since };
    history.push(next);
    latestByKey.set(key(row), next);
  }
}
const unique = history;
await mkdir(new URL('../src', import.meta.url), { recursive: true });
await writeFile(new URL('../src/pricing.generated.json', import.meta.url), `${JSON.stringify(unique, null, 2)}\n`);
const columns = ['provider', 'model', 'tier', 'threshold', 'since', 'input', 'cachedInput', 'cacheWrite', 'output'];
const csv = [columns.join(','), ...unique.map(row => columns.map(column => JSON.stringify(row[column] ?? '')).join(','))].join('\n') + '\n';
await writeFile(new URL('../pricing.generated.csv', import.meta.url), csv);
console.log(`Generated ${unique.length} pricing rows from ${source}`);
