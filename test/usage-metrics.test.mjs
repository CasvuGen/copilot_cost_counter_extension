import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCacheHitRate } from '../dist/usageMetrics.js';

test('formats cache hit rate from cached and prompt tokens', () => {
  assert.equal(formatCacheHitRate(1000, 275), '27.5%');
});

test('reports unavailable when prompt tokens are absent', () => {
  assert.equal(formatCacheHitRate(0, 0), 'Unavailable');
  assert.equal(formatCacheHitRate(Number.NaN, 10), 'Unavailable');
});

test('bounds malformed cache totals to the valid percentage range', () => {
  assert.equal(formatCacheHitRate(100, 120), '100.0%');
  assert.equal(formatCacheHitRate(100, -5), '0.0%');
});