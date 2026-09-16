import {
  CONVERSATION_ID_PATTERN,
  type ConversationLocation,
  type ConversationSnapshot,
} from "./conversation-types.js";
/** Transcript storage and domain authorization remain with the consuming app. */
export interface EvidenceRepository {
  listAll(): Promise<
    Array<{ location: ConversationLocation; unavailableReason?: string }>
  >;
  read(location: ConversationLocation): Promise<ConversationSnapshot>;
}
export function conversationLocationFromSourcePath(
  path: string,
): ConversationLocation | null {
  const match = path.match(
    /^(?:(.*)\/)?\.lapis\/agents\/sessions\/([^/]+)(?:\/|$)/u,
  );
  const conversationId = match?.[2];
  if (!conversationId || !CONVERSATION_ID_PATTERN.test(conversationId))
    return null;
  return { scopeDir: match?.[1] ?? "", conversationId };
}
