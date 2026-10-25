import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copilotChatDebugFileLoggingSetting,
  legacyCopilotChatDebugFileLoggingSetting,
  resolveUsageSource
} from '../dist/usageSource.js';

test('auto prefers structured logs when logging is enabled or files already exist', () => {
  assert.equal(resolveUsageSource('auto', true, false), 'debugLogs');
  assert.equal(resolveUsageSource('auto', false, true), 'debugLogs');
});

test('auto falls back to output logs when structured logs are unavailable', () => {
  assert.equal(resolveUsageSource('auto', false, false), 'outputLog');
});

test('explicit source preferences are respected', () => {
  assert.equal(resolveUsageSource('outputLog', true, true), 'outputLog');
  assert.equal(resolveUsageSource('debugLogs', false, false), 'debugLogs');
});

test('uses Copilot Chat’s supported debug file-logging setting key', () => {
  assert.equal(copilotChatDebugFileLoggingSetting, 'github.copilot.chat.agentDebugLog.fileLogging.enabled');
  assert.equal(legacyCopilotChatDebugFileLoggingSetting, 'chat.agentDebugLog.fileLogging.enabled');
});
