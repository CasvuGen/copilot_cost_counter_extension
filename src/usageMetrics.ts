export function formatCacheHitRate(promptTokens: number, cachedTokens: number): string {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0 || !Number.isFinite(cachedTokens)) return 'Unavailable';
  const percentage = Math.min(100, Math.max(0, cachedTokens) / promptTokens * 100);
  return `${percentage.toFixed(1)}%`;
}