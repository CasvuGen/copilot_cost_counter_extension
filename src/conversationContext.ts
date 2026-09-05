export type ConversationTurn = { chatId: string; turnId: string };

export function resolveConversationContext(
  request: Partial<ConversationTurn> | undefined,
  parsed: Partial<ConversationTurn> | undefined,
  websocketResponse: Partial<ConversationTurn> | undefined,
  activeConversationTurn: ConversationTurn | undefined
): ConversationTurn | undefined {
  const chatId = request?.chatId ?? parsed?.chatId ?? websocketResponse?.chatId ?? activeConversationTurn?.chatId;
  const turnId = request?.turnId ?? parsed?.turnId ?? websocketResponse?.turnId ?? activeConversationTurn?.turnId;
  return chatId && turnId ? { chatId, turnId } : undefined;
}