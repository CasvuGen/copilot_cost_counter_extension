import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOutputLogUsageLine } from '../dist/outputLogUsage.js';

test('extracts successful request metadata and token aliases', () => {
  assert.deepEqual(parseOutputLogUsageLine('2026-01-15 09:00:00.100 ccreq:req-1.copilotmd | success | gpt-5.4 | 520ms | [panel/askAgent] input_tokens=120 output_tokens=40 cacheTokens=30 cacheWriteTokens=4'), {
    requestId: 'req-1',
    timestamp: '2026-01-15 09:00:00.100',
    model: 'gpt-5.4',
    feature: 'panel/askAgent',
    durationMs: 520,
    promptTokens: 120,
    outputTokens: 40,
    cacheTokens: 30,
    cacheWriteTokens: 4
  });
});

test('returns null for token fields omitted by the source log', () => {
  const parsed = parseOutputLogUsageLine('2026-01-15 09:00:00.100 ccreq:req-2.copilotmd | success | gpt-5.4 | 10ms | [panel/askAgent]');
  assert.equal(parsed?.promptTokens, null);
  assert.equal(parsed?.outputTokens, null);
  assert.equal(parsed?.cacheTokens, null);
});

test('ignores malformed and unsuccessful request records', () => {
  assert.equal(parseOutputLogUsageLine('not a Copilot log line'), undefined);
  assert.equal(parseOutputLogUsageLine('2026-01-15 09:00:00.100 ccreq:req-3.copilotmd | failed | gpt-5.4 | 10ms | [panel/askAgent]'), undefined);
});