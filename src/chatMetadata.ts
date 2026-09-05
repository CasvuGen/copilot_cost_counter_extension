export type CopilotSessionMetadata = {
  customTitle?: unknown;
  firstUserMessage?: unknown;
  v?: { requests?: { message?: { text?: unknown }; prompt?: unknown }[] };
};

function usableSessionTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/\s+/g, ' ').trim();
  return title ? title : undefined;
}

export function sessionTitleFromMetadata(session: CopilotSessionMetadata | undefined): string | undefined {
  const directTitle = usableSessionTitle(session?.customTitle) ?? usableSessionTitle(session?.firstUserMessage);
  if (directTitle) return directTitle;
  for (const request of session?.v?.requests ?? []) {
    const requestTitle = usableSessionTitle(request.message?.text) ?? usableSessionTitle(request.prompt);
    if (requestTitle) return requestTitle;
  }
  return undefined;
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