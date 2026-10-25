import assert from 'node:assert/strict';
import test from 'node:test';
import {
  copilotChatDebugFileLoggingSetting,
  legacyCopilotChatDebugFileLoggingSetting,
  usageSourcesForPreference
} from '../dist/usageSource.js';

test('auto reads both available sources instead of selecting one from a setting flag', () => {
  assert.deepEqual(usageSourcesForPreference('auto'), ['outputLog', 'debugLogs']);
});

test('explicit source preferences are respected', () => {
  assert.deepEqual(usageSourcesForPreference('outputLog'), ['outputLog']);
  assert.deepEqual(usageSourcesForPreference('debugLogs'), ['debugLogs']);
});

test('uses Copilot Chat’s supported debug file-logging setting key', () => {
  assert.equal(copilotChatDebugFileLoggingSetting, 'github.copilot.chat.agentDebugLog.fileLogging.enabled');
  assert.equal(legacyCopilotChatDebugFileLoggingSetting, 'chat.agentDebugLog.fileLogging.enabled');
});
