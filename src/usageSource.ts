export type UsageSourcePreference = 'auto' | 'outputLog' | 'debugLogs';
export type UsageSource = Exclude<UsageSourcePreference, 'auto'>;

export const copilotChatDebugFileLoggingSetting = 'chat.agentDebugLog.fileLogging.enabled';
export const legacyCopilotChatDebugFileLoggingSetting = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';

export function resolveUsageSource(
  preference: UsageSourcePreference,
  chatDebugLoggingEnabled: boolean,
  debugLogsAvailable: boolean
): UsageSource {
  if (preference !== 'auto') return preference;
  return chatDebugLoggingEnabled || debugLogsAvailable ? 'debugLogs' : 'outputLog';
}
