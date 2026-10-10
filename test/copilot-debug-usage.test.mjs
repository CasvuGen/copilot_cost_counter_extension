import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCopilotDebugSpan } from '../dist/copilotDebugUsage.js';

test('extracts measured token, cache, model, and AI-unit fields', () => {
  const span = parseCopilotDebugSpan(JSON.stringify({
    type: 'llm_request',
    name: 'chat:model-from-name',
    sid: 'session-1',
    ts: 1_800_000_000_000,
    spanId: 'span-1',
    attrs: { model: 'model-from-attrs', inputTokens: 120, outputTokens: 40, cachedTokens: 30, copilotUsageNanoAiu: 250_000_000 }
  }));
  assert.deepEqual(span, {
    key: 'span-1',
    sessionId: 'session-1',
    timestamp: 1_800_000_000_000,
    model: 'model-from-attrs',
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