export type UsageSourcePreference = 'auto' | 'outputLog' | 'debugLogs';
export type UsageSource = Exclude<UsageSourcePreference, 'auto'>;

export const copilotChatDebugFileLoggingSetting = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';
export const legacyCopilotChatDebugFileLoggingSetting = 'chat.agentDebugLog.fileLogging.enabled';

export function resolveUsageSource(
  preference: UsageSourcePreference,
  chatDebugLoggingEnabled: boolean,
  debugLogsAvailable: boolean
): UsageSource {
  if (preference !== 'auto') return preference;
  return chatDebugLoggingEnabled || debugLogsAvailable ? 'debugLogs' : 'outputLog';
}
