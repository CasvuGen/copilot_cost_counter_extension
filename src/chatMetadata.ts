export type CopilotSessionMetadata = {
  customTitle?: unknown;
  firstUserMessage?: unknown;
  v?: { customTitle?: unknown; sessionId?: unknown; requests?: { requestId?: unknown; message?: { text?: unknown }; prompt?: unknown }[] };
  k?: unknown;
};

export type PersistedChatSession = { chatId: string; title?: string; titleSource?: 'copilot' | 'firstUserMessage'; firstUserMessage?: string; turnIds: string[] };

export function isPersistedChatTitleSource(value: unknown): value is 'copilot' | 'firstUserMessage' {
  return value === 'copilot' || value === 'firstUserMessage';
}

export function firstUserMessageLabel(value: string): string {
  return value.slice(0, 50);
}

export function isUsableConversationTitle(title: string | undefined): title is string {
  return Boolean(title && title.trim() && !/^sorry,?\s+i can't assist with that\.?$/i.test(title.trim()));
}

function usableSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  return title ? title : undefined;
}

export function sessionTitleFromMetadata(session: CopilotSessionMetadata | undefined): string | undefined {
  return usableSessionTitle(session?.customTitle) ?? usableSessionTitle(session?.v?.customTitle);
}

export function persistedChatSessionFromJsonl(content: string): PersistedChatSession | undefined {
  let chatId: string | undefined;
  let title: string | undefined;
  let firstUserMessage: string | undefined;
  const turnIds = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const session = JSON.parse(line) as CopilotSessionMetadata;
      chatId ??= usableSessionTitle(session.v?.sessionId);
      title ??= sessionTitleFromMetadata(session);
      firstUserMessage ??= usableSessionTitle(session.firstUserMessage);
      const requests = session.v?.requests ?? (Array.isArray(session.k) && session.k[0] === 'requests' && Array.isArray(session.v) ? session.v : []);
      for (const request of requests) {
        const requestId = usableSessionTitle(request.requestId);
        if (requestId) turnIds.add(requestId);
        firstUserMessage ??= usableSessionTitle(request.message?.text) ?? usableSessionTitle(request.prompt);
      }
    } catch {
      continue;
    }
  }
  return chatId ? title
    ? { chatId, title, titleSource: 'copilot', ...(firstUserMessage ? { firstUserMessage: firstUserMessageLabel(firstUserMessage) } : {}), turnIds: [...turnIds] }
    : firstUserMessage
      ? { chatId, title: firstUserMessageLabel(firstUserMessage), titleSource: 'firstUserMessage', firstUserMessage: firstUserMessageLabel(firstUserMessage), turnIds: [...turnIds] }
      : { chatId, turnIds: [...turnIds] }
    : undefined;
}

export function sessionTitleFromJsonl(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const title = sessionTitleFromMetadata(JSON.parse(line) as CopilotSessionMetadata);
      if (title) return title;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function sessionContainsTurn(content: string, turnIds: readonly string[]): boolean {
  return turnIds.some(turnId => content.includes(turnId));
}