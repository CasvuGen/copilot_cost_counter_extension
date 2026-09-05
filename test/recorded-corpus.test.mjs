import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { persistedChatSessionFromJsonl } from '../dist/chatMetadata.js';

const corpusDirectory = 'test_data/synthetic-corpus';
const selectedSessionIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
];

test('synthetic corpus usage rows are valid request records', async () => {
  const lines = (await readFile(`${corpusDirectory}/workspace-copilot/usage.jsonl`, 'utf8')).trim().split(/\r?\n/);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.equal(typeof record.requestId, 'string');
    assert.equal(typeof record.timestamp, 'string');
    assert.equal(typeof record.feature, 'string');
  }
});

test('synthetic corpus session journals expose stable client sessions and safe labels', async () => {
  const files = (await readdir(`${corpusDirectory}/chatSessions`)).filter(file => file.endsWith('.jsonl'));
  assert.deepEqual(files.sort(), selectedSessionIds.map(id => `${id}.jsonl`));
  const sessions = await Promise.all(files.map(async file => persistedChatSessionFromJsonl(await readFile(`${corpusDirectory}/chatSessions/${file}`, 'utf8'))));
  assert.ok(sessions.some(session => session?.chatId === '22222222-2222-4222-8222-222222222222'));
  for (const session of sessions.filter(Boolean)) {
    assert.ok(session.chatId.length > 0);
    assert.ok(session.turnIds.length > 0);
  }
  const fallbackTitledSession = sessions.find(session => session?.chatId === '22222222-2222-4222-8222-222222222222');
  assert.equal(fallbackTitledSession?.title, 'Synthetic initial label');
  assert.equal(fallbackTitledSession?.titleSource, 'firstUserMessage');
  assert.equal(fallbackTitledSession?.firstUserMessage, 'Synthetic initial label');
  const titledSession = sessions.find(session => session?.chatId === '11111111-1111-4111-8111-111111111111');
  assert.equal(titledSession?.title, 'Synthetic titled chat');
  assert.equal(titledSession?.titleSource, 'copilot');
  assert.deepEqual(titledSession?.turnIds, [
    'request_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'request_dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ]);
});

test('synthetic corpus retains matching transcript, debug, and durable metadata sources', async () => {
  for (const sessionId of selectedSessionIds) {
    assert.equal(existsSync(`${corpusDirectory}/transcripts/${sessionId}.jsonl`), true);
    assert.equal(existsSync(`${corpusDirectory}/debug-logs/${sessionId}/main.jsonl`), true);
    assert.equal(existsSync(`${corpusDirectory}/debug-logs/${sessionId}/models.json`), true);
  }
  const metadata = JSON.parse(await readFile(`${corpusDirectory}/copilot-home/vscode.session.metadata.cache.json`, 'utf8'));
  assert.equal(typeof metadata, 'object');
});

test('synthetic corpus includes production-shaped asynchronous correlation events', async () => {
  const files = (await readdir(`${corpusDirectory}/copilot-extension-host-logs`)).filter(file => file.endsWith('.log'));
  assert.deepEqual(files, ['GitHub Copilot Chat.log']);
  const logs = await Promise.all(files.map(file => readFile(`${corpusDirectory}/copilot-extension-host-logs/${file}`, 'utf8')));
  const content = logs.join('\n');
  assert.match(content, /ccreq:[^\s.]+\.copilotmd\s+\|\s+success/i);
  assert.match(content, /\[VoiceProgress\]\s+loop\s+request=/i);
  assert.match(content, /\[ChatWebSocketManager\].*conversation/i);
  assert.match(content, /\[VoiceProgress\]\s+loop\s+request=[0-9a-f-]{36}.*\bsubagent=true/i);
});

test('synthetic corpus has no personal input text or local paths', async () => {
  const files = [
    `${corpusDirectory}/workspace-copilot/usage.jsonl`,
    `${corpusDirectory}/workspace-copilot/usage_metadata.json`,
    `${corpusDirectory}/copilot-extension-host-logs/GitHub Copilot Chat.log`,
    `${corpusDirectory}/copilot-home/vscode.session.metadata.cache.json`,
    ...selectedSessionIds.map(id => `${corpusDirectory}/chatSessions/${id}.jsonl`),
    ...selectedSessionIds.map(id => `${corpusDirectory}/transcripts/${id}.jsonl`),
    ...selectedSessionIds.flatMap(id => [`${corpusDirectory}/debug-logs/${id}/main.jsonl`, `${corpusDirectory}/debug-logs/${id}/models.json`])
  ];
  const contents = await Promise.all(files.map(file => readFile(file, 'utf8')));
  for (const content of contents) {
    assert.doesNotMatch(content, /\/Users\/|mikaelkarkkonen|Activity > Chats/i);
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (Array.isArray(event.k) && event.k.at(-1) === 'inputText') assert.equal(event.v, 'Input text');
      } catch {
        // Log lines are intentionally plain text, like the extension-host output.
      }
    }
  }
});