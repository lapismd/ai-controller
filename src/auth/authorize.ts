import {
  ControllerError,
  type AuthSession,
  type Json,
  type MemoryAccess,
  type Thread,
} from "../contracts.js";

const CLIENT_IDENTITY_FIELDS = [
  "principalId",
  "applicationId",
  "workspaceId",
  "owner",
  "scope",
  "partition",
  "access",
] as const;

export function applicationOf(thread: Thread): string {
  return thread.application ?? thread.owner;
}

export function endpointKey(
  principalId: string,
  applicationId: string,
  id: string,
): string {
  return `${principalId}:${applicationId}:${id}`;
}

export function threadEndpointKey(thread: Thread, id: string): string {
  return endpointKey(thread.owner, applicationOf(thread), id);
}

export function requireResource(session: AuthSession, thread: Thread): void {
  if (
    thread.owner !== session.principalId ||
    applicationOf(thread) !== session.applicationId ||
    !session.providers.includes(thread.provider) ||
    !session.workspaces.includes(thread.workspace)
  )
    throw new ControllerError("not_found", "Thread not found");
}

export function memoryAccess(session: AuthSession, thread: Thread): MemoryAccess {
  return {
    principalId: session.principalId,
    applicationId: session.applicationId,
    workspaceId: thread.workspace,
    threadId: thread.id,
  };
}

export function authorizeMemoryInput(
  input: Json,
  access: MemoryAccess,
): Json {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Record<string, Json>) }
      : {};
  for (const field of CLIENT_IDENTITY_FIELDS) delete record[field];
  return { ...record, access: access as unknown as Json };
}
