import assert from 'node:assert/strict';
import test from 'node:test';
import { deduplicateUsageRecords } from '../dist/usageDeduplication.js';

function record(overrides = {}) {
  return {
    requestId: 'output:request-1',
    sourceLog: '/window/output.log',
    timestamp: '2026-10-25T10:00:00.000Z',
    model: 'gpt-6-luna',
    requestType: 'chat',
    turnId: 'turn-1',
    promptTokens: 100,
    outputTokens: 30,
    cacheTokens: 20,
    cacheWriteTokens: null,
    aiCredits: null,
    costUsd: null,
    ...overrides
  };
}

test('deduplicates cross-source records for the same turn and model call', () => {
  const outputLog = record();
  const debugLog = record({
    requestId: 'debug:session-1:span-1',
    sourceLog: 'copilot-debug/session-1/main.jsonl',
    timestamp: '2026-10-25T10:00:01.000Z',
    aiCredits: 0.25,
    costUsd: 0.0025
  });

  assert.deepEqual(deduplicateUsageRecords([outputLog, debugLog]), [debugLog]);
});

test('does not deduplicate different turns, models, token usage, or same-source requests', () => {
  const base = record();
  const otherTurn = record({ requestId: 'other-turn', turnId: 'turn-2' });
  const otherModel = record({ requestId: 'other-model', model: 'gpt-6-sol' });
  const otherTokens = record({
    requestId: 'other-tokens',
    sourceLog: 'copilot-debug/session-1/main.jsonl',
    promptTokens: 101
  });
  const sameSource = record({ requestId: 'same-source-copy' });

  assert.equal(deduplicateUsageRecords([base, otherTurn, otherModel, otherTokens, sameSource]).length, 5);
});

test('does not deduplicate matching calls outside the cross-source timestamp window', () => {
  const outputLog = record();
  const debugLog = record({
    requestId: 'debug:session-1:span-1',
    sourceLog: 'copilot-debug/session-1/main.jsonl',
    timestamp: '2026-10-25T10:00:01.001Z'
  });

  assert.equal(deduplicateUsageRecords([outputLog, debugLog]).length, 2);
});

test('deduplicates Agent Host copies by exact request ID', () => {
  const first = record({
    requestId: 'agenthost:session-1:call-1',
    sourceLog: 'agent-host/session-1'
  });
  const duplicate = record({
    requestId: 'agenthost:session-1:call-1',
    sourceLog: 'agent-host/session-1',
    aiCredits: 0.1
  });

  assert.deepEqual(deduplicateUsageRecords([first, duplicate]), [duplicate]);
});
