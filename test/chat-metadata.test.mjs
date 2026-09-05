import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sessionContainsTurn, sessionTitleFromJsonl, sessionTitleFromMetadata } from '../dist/chatMetadata.js';

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

test('falls back to the persisted first user message', () => {
  assert.equal(sessionTitleFromMetadata({ firstUserMessage: '  Explain this error\nplease ' }), 'Explain this error please');
});

test('falls back to the first nested request message for older sessions', () => {
  assert.equal(
    sessionTitleFromMetadata({ v: { requests: [{ message: { text: 'Help me debug the build' } }] } }),
    'Help me debug the build'
  );
});

test('resolves the title from a legacy JSONL session fixture', async () => {
  const lines = (await readFile(fixturePath('chat-session-legacy.jsonl'), 'utf8')).trim().split(/\r?\n/);
  assert.equal(sessionTitleFromMetadata(JSON.parse(lines[0])), 'Explain this build error please');
});

test('resolves a title from a later incremental session event', async () => {
  const content = await readFile(fixturePath('chat-session-incremental.jsonl'), 'utf8');
  assert.equal(sessionTitleFromJsonl(content), 'allo!');
  assert.equal(sessionContainsTurn(content, ['request_6de70366-605e-4a08-8af3-cb9316ade7c0']), true);
  assert.equal(sessionContainsTurn(content, ['request-from-another-chat']), false);
});

test('ignores blank and non-string title values', () => {
  assert.equal(sessionTitleFromMetadata({ customTitle: '  ', firstUserMessage: 42, v: { requests: [{ prompt: '' }] } }), undefined);
});