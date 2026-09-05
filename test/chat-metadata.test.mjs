import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { firstUserMessageLabel, isPersistedChatTitleSource, isUsableConversationTitle, persistedChatSessionFromJsonl, sessionContainsTurn, sessionTitleFromJsonl, sessionTitleFromMetadata } from '../dist/chatMetadata.js';

const fixturePath = name => fileURLToPath(new URL(`../test_data/${name}`, import.meta.url));

async function readJsonFixture(name) {
  return JSON.parse(await readFile(fixturePath(name), 'utf8'));
}

test('prefers a persisted custom title from a current .json session', () => {
  assert.equal(
    sessionTitleFromMetadata({ customTitle: '  Configure   CSS modules  ', firstUserMessage: 'Use CSS' }),
    'Configure CSS modules'
  );
});

test('resolves the title from a current VS Code session fixture', async () => {
  assert.equal(
    sessionTitleFromMetadata(await readJsonFixture('chat-session-current.json')),
    'Configure CSS modules in Vite'
  );
});

test('resolves a custom title from a VS Code JSONL journal payload', () => {
  assert.equal(sessionTitleFromJsonl('{"kind":0,"v":{"sessionId":"synthetic-session","customTitle":"Journal title"}}'), 'Journal title');
});

test('collects a later turn from a VS Code requests patch event', () => {
  const content = [
    '{"kind":0,"v":{"sessionId":"synthetic-session","customTitle":"Journal title","requests":[{"requestId":"request-first","message":{"text":"Initial request"}}]}}',
    '{"kind":1,"k":["requests"],"v":[{"requestId":"request-second"}]}'
  ].join('\n');
  assert.deepEqual(persistedChatSessionFromJsonl(content), {
    chatId: 'synthetic-session',
    title: 'Journal title',
    titleSource: 'copilot',
    firstUserMessage: 'Initial request',
    turnIds: ['request-first', 'request-second']
  });
});

test('does not use the first user message as a generated chat title', () => {
  assert.equal(sessionTitleFromMetadata({ firstUserMessage: '  Explain this error\nplease ' }), undefined);
});

test('does not use a nested request message as a generated chat title', () => {
  assert.equal(sessionTitleFromMetadata({ v: { requests: [{ message: { text: 'Help me debug the build' } }] } }), undefined);
});

test('does not treat a legacy session prompt as a generated title', async () => {
  const lines = (await readFile(fixturePath('chat-session-legacy.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(sessionTitleFromMetadata(JSON.parse(lines[0])), undefined);
});

test('uses the first user message when a session has no generated title', async () => {
  const content = await readFile(fixturePath('chat-session-incremental.jsonl'), 'utf8');
  assert.equal(sessionTitleFromJsonl(content), undefined);
  assert.equal(sessionContainsTurn(content, ['request_6de70366-605e-4a08-8af3-cb9316ade7c0']), true);
  assert.equal(sessionContainsTurn(content, ['request-from-another-chat']), false);
  assert.deepEqual(persistedChatSessionFromJsonl(content), {
    chatId: 'client-session-allotest',
    title: 'allo!',
    titleSource: 'firstUserMessage',
    firstUserMessage: 'allo!',
    turnIds: ['request_6de70366-605e-4a08-8af3-cb9316ade7c0']
  });
});

test('ignores blank and non-string title values', () => {
  assert.equal(sessionTitleFromMetadata({ customTitle: '  ', firstUserMessage: 42, v: { requests: [{ prompt: '' }] } }), undefined);
});

test('identifies persisted title sources', () => {
  assert.equal(isPersistedChatTitleSource('copilot'), true);
  assert.equal(isPersistedChatTitleSource('firstUserMessage'), true);
  assert.equal(isPersistedChatTitleSource('unavailable'), false);
});

test('rejects Copilot policy responses as generated titles', () => {
  assert.equal(isUsableConversationTitle("Sorry, I can't assist with that."), false);
});