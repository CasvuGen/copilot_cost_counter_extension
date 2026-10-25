import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAgentHostUsageForWorkspace, parseAgentHostUsageLog, parseCopilotDebugSpan } from '../dist/copilotDebugUsage.js';

test('parses Agent Host model calls and converts cumulative turn AIU to per-call amounts', () => {
  const records = parseAgentHostUsageLog([
    { apiCallId: 'call-1', turnId: 'turn-1', model: 'gpt-5', inputTokens: 120, outputTokens: 40, cacheReadTokens: 30, totalNanoAiu: 1_000_000_000, ts: '2026-10-18T10:00:00.000Z' },
    { apiCallId: 'call-2', turnId: 'turn-1', model: 'gpt-5', inputTokens: 200, outputTokens: 50, totalNanoAiu: 2_500_000_000, ts: '2026-10-18T10:00:10.000Z' },
    { apiCallId: 'child-call', turnId: 'turn-1', agentId: 'agent-1', model: 'gpt-5-mini', inputTokens: 80, outputTokens: 20, totalNanoAiu: 2_500_000_000, ts: '2026-10-18T10:00:05.000Z' }
  ].map(record => JSON.stringify(record)).join('\n'));

  assert.deepEqual(records.map(record => record.nanoAiu), [1_000_000_000, 1_500_000_000, 0]);
  assert.deepEqual(records[0], {
    key: 'call-1', timestamp: Date.parse('2026-10-18T10:00:00.000Z'), model: 'gpt-5', turnId: 'turn-1',
    inputTokens: 120, outputTokens: 40, cachedTokens: 30, nanoAiu: 1_000_000_000
  });
});

test('skips malformed and empty Agent Host usage records', () => {
  assert.deepEqual(parseAgentHostUsageLog('not json\n{"ts":"invalid","inputTokens":1}\n{}'), []);
});

test('filters global Agent Host sidecars to sessions and turns persisted in the current workspace', () => {
  const records = parseAgentHostUsageLog([
    { apiCallId: 'current-call', turnId: 'current-turn', inputTokens: 10, outputTokens: 2, ts: '2026-10-20T10:00:00.000Z' },
    { apiCallId: 'other-call', turnId: 'other-turn', inputTokens: 20, outputTokens: 4, ts: '2026-10-20T10:00:01.000Z' },
    { apiCallId: 'unassociated-call', inputTokens: 30, outputTokens: 6, ts: '2026-10-20T10:00:02.000Z' }
  ].map(record => JSON.stringify(record)).join('\n'));

  assert.deepEqual(filterAgentHostUsageForWorkspace(records, new Set(['current-turn']), 'other-chat', new Set(['current-chat'])).map(record => record.key), ['current-call']);
  assert.deepEqual(filterAgentHostUsageForWorkspace(records, new Set(), 'other-chat', new Set(['current-chat'])).map(record => record.key), []);
});

test('keeps Agent Host records for a known chat while its turn journal is still pending', () => {
  const records = parseAgentHostUsageLog([
    { apiCallId: 'pending-turn-call', turnId: 'not-persisted-yet', inputTokens: 10, outputTokens: 2, ts: '2026-10-20T10:00:00.000Z' },
    { apiCallId: 'missing-turn-call', inputTokens: 20, outputTokens: 4, ts: '2026-10-20T10:00:01.000Z' }
  ].map(record => JSON.stringify(record)).join('\n'));

  assert.deepEqual(filterAgentHostUsageForWorkspace(records, new Set(), 'current-chat', new Set(['current-chat'])).map(record => record.key), ['pending-turn-call', 'missing-turn-call']);
  assert.deepEqual(filterAgentHostUsageForWorkspace(records, new Set(), 'other-chat', new Set(['current-chat'])), []);
});

test('extracts measured token, cache, model, and AI-unit fields', () => {
  const span = parseCopilotDebugSpan(JSON.stringify({
    type: 'llm_request',
    name: 'chat:model-from-name',
    sid: 'session-1',
    ts: 1_800_000_000_000,
    spanId: 'span-1',
    attrs: { model: 'model-from-attrs', turnId: 'turn-1', inputTokens: 120, outputTokens: 40, cachedTokens: 30, copilotUsageNanoAiu: 250_000_000 }
  }));
  assert.deepEqual(span, {
    key: 'span-1',
    sessionId: 'session-1',
    timestamp: 1_800_000_000_000,
    model: 'model-from-attrs',
    turnId: 'turn-1',
    inputTokens: 120,
    outputTokens: 40,
    cachedTokens: 30,
    nanoAiu: 250_000_000
  });
});

test('accepts an explicit zero AI-unit amount without treating it as missing', () => {
  const span = parseCopilotDebugSpan(JSON.stringify({
    type: 'llm_request', name: 'chat:model', ts: 10,
    attrs: { inputTokens: 0, outputTokens: 0, copilotUsageNanoAiu: 0 }
  }));
  assert.equal(span?.nanoAiu, 0);
});

test('uses a stable fallback key when the span omits its id', () => {
  const line = JSON.stringify({
    type: 'llm_request', name: 'chat:model', sid: 'session-1', ts: 10,
    attrs: { inputTokens: 3, outputTokens: 2 }
  });
  assert.equal(parseCopilotDebugSpan(line)?.key, parseCopilotDebugSpan(line)?.key);
  assert.equal(typeof parseCopilotDebugSpan(line)?.key, 'string');
});

test('rejects malformed, non-chat, and incomplete events', () => {
  assert.equal(parseCopilotDebugSpan('not json'), undefined);
  assert.equal(parseCopilotDebugSpan('{"type":"llm_request","name":"embed:model","attrs":{}}'), undefined);
  assert.equal(parseCopilotDebugSpan('{"type":"llm_request","name":"chat:model","ts":10,"attrs":{"inputTokens":1}}'), undefined);
  assert.equal(parseCopilotDebugSpan('{"type":"llm_request","name":"chat:model","ts":1e30,"attrs":{"inputTokens":1,"outputTokens":1}}'), undefined);
  assert.equal(parseCopilotDebugSpan('{"type":"llm_request","name":"chat:","ts":10,"attrs":{"inputTokens":1,"outputTokens":1}}'), undefined);
});