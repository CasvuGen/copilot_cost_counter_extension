import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveConversationContext } from '../dist/conversationContext.js';

const logFixture = fileURLToPath(new URL('../test_data/copilot-log-sequence.jsonl', import.meta.url));

test('uses the active log conversation when a ccreq record has no IDs', () => {
  assert.deepEqual(
    resolveConversationContext(undefined, undefined, undefined, { chatId: 'chat-1', turnId: 'turn-1' }),
    { chatId: 'chat-1', turnId: 'turn-1' }
  );
});

test('associates each ccreq-shaped event with the latest conversation marker', async () => {
  const events = (await readFile(logFixture, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line));
  let active;
  const associations = [];
  for (const event of events) {
    const marker = event.message.match(/conversation (\S+) turn (\S+)/);
    if (marker) active = { chatId: marker[1], turnId: marker[2] };
    if (event.message.startsWith('ccreq ')) {
      associations.push(resolveConversationContext(undefined, undefined, undefined, active));
    }
  }
  assert.deepEqual(associations, [
    { chatId: 'chat-fixture-001', turnId: 'turn-fixture-001' },
    { chatId: 'chat-fixture-002', turnId: 'turn-fixture-002' }
  ]);
});

test('prefers IDs from the request over parsed, websocket, and active values', () => {
  assert.deepEqual(
    resolveConversationContext(
      { chatId: 'request-chat', turnId: 'request-turn' },
      { chatId: 'parsed-chat', turnId: 'parsed-turn' },
      { chatId: 'websocket-chat', turnId: 'websocket-turn' },
      { chatId: 'active-chat', turnId: 'active-turn' }
    ),
    { chatId: 'request-chat', turnId: 'request-turn' }
  );
});

test('does not create incomplete metadata when either ID is missing', () => {
  assert.equal(resolveConversationContext({ chatId: 'chat-1' }, undefined, undefined, undefined), undefined);
  assert.equal(resolveConversationContext(undefined, { turnId: 'turn-1' }, undefined, undefined), undefined);
});