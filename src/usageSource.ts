export type UsageSourcePreference = 'auto' | 'outputLog' | 'debugLogs';
export type UsageSource = Exclude<UsageSourcePreference, 'auto'>;

export const copilotChatDebugFileLoggingSetting = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';
export const legacyCopilotChatDebugFileLoggingSetting = 'chat.agentDebugLog.fileLogging.enabled';

export function usageSourcesForPreference(preference: UsageSourcePreference): UsageSource[] {
  return preference === 'auto' ? ['outputLog', 'debugLogs'] : [preference];
}
