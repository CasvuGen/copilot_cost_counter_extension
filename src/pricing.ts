export type ModelPricing = { input: number; cachedInput?: number; cacheWrite?: number; output: number };
export type PricingOverrides = Record<string, Partial<ModelPricing>>;
export type PricingRow = ModelPricing & { model: string; tier: string; threshold?: string };

export function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/\[[^\]]+\]/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

function tokenThreshold(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!match) return undefined;
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return Number(match[1]) * scale;
}

export function createPricingLookup(rows: readonly PricingRow[]) {
  const tiers = new Map<string, { fallback?: PricingRow; standard?: PricingRow; longContext?: PricingRow }>();
  for (const row of rows) {
    const key = normalizeModel(row.model);
    const current = tiers.get(key) ?? {};
    if (row.tier.toLowerCase().includes('long')) {
      current.longContext = row;
      current.fallback ??= row;
    }
    else {
      current.fallback = row;
      if (row.tier.toLowerCase() === 'default') current.standard = row;
    }
    tiers.set(key, current);
  }

  return (model: string, inputTokens: number | null, overrides: PricingOverrides = {}): ModelPricing | undefined => {
    const key = normalizeModel(model);
    const modelTiers = tiers.get(key);
    const standard = modelTiers?.standard ?? modelTiers?.fallback;
    const threshold = tokenThreshold(modelTiers?.longContext?.threshold);
    const selected = modelTiers?.longContext && inputTokens !== null && threshold !== undefined && inputTokens > threshold
      ? modelTiers.longContext
      : standard;
    const override = Object.entries(overrides).find(([name]) => normalizeModel(name) === key)?.[1];
    if (typeof override?.input === 'number' && typeof override.output === 'number') {
      return {
        input: override.input,
        output: override.output,
        cachedInput: typeof override.cachedInput === 'number' ? override.cachedInput : selected?.cachedInput,
        cacheWrite: typeof override.cacheWrite === 'number' ? override.cacheWrite : selected?.cacheWrite
      };
    }
    return selected;
  };
}