import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

for (const file of [
  'dist/extension.js',
  'dist/chatMetadata.js',
  'dist/conversationContext.js',
  'templates/report.html',
  'templates/chat-group.html',
  'test_data/copilot-log-sequence.jsonl',
  'test_data/chat-session-current.json',
  'test_data/chat-session-legacy.jsonl'
]) {
  test(`package input exists: ${file}`, async () => {
    await assert.doesNotReject(access(file));
  });
}