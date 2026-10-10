import assert from 'node:assert/strict';
import test from 'node:test';
import { createPricingLookup } from '../dist/pricing.js';

const rows = [
  { model: 'Model 5', tier: 'Default', threshold: '≤ 272K', input: 1, cachedInput: 0.1, output: 4 },
  { model: 'Model 5', tier: 'Long context', threshold: '> 272K', input: 2, cachedInput: 0.2, output: 6 },
  { model: 'Model 5', tier: 'Default', threshold: '≤ 272K', input: 1.5, cachedInput: 0.15, output: 5 }
];

const pricingFor = createPricingLookup(rows);

test('uses the latest default price through the context threshold', () => {
  assert.equal(pricingFor('Model 5', 272_000).input, 1.5);
  assert.equal(pricingFor('Model 5', 272_000).output, 5);
});

test('uses long-context rates above the context threshold', () => {
  assert.equal(pricingFor('model-5', 272_001).input, 2);
  assert.equal(pricingFor('model-5', 272_001).output, 6);
});

test('overrides win while unspecified cache rates inherit the selected tier', () => {
  assert.deepEqual(pricingFor('Model 5', 300_000, { 'model-5': { input: 3, output: 7 } }), {
    input: 3,
    output: 7,
    cachedInput: 0.2,
    cacheWrite: undefined
  });
});

test('unknown models remain without a guessed rate', () => {
  assert.equal(pricingFor('unknown-model', 10), undefined);
});

test('uses the available long-context row when no default row exists', () => {
  const longOnly = createPricingLookup([
    { model: 'Long Only', tier: 'Long context', threshold: '> 100K', input: 2, output: 8 }
  ]);
  assert.equal(longOnly('Long Only', 10).input, 2);
});