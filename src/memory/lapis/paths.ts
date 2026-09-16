import type { MemoryScope } from "./types.js";

export const AI_MEMORY_EPISODIC_PROVIDER_ID = "ai-memory-episodic";
export const AI_MEMORY_CURATED_PROVIDER_ID = "ai-memory-curated";
export const AI_MEMORY_PATH_PREFIX = "ai-memory";

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "~");
}

export function decodeMemoryPathSegment(value: string): string {
  return decodeURIComponent(value.replaceAll("~", "%"));
}

export function conversationMemoryScope(scopeDir: string): MemoryScope {
  return scopeDir
    ? { kind: "project", projectDir: scopeDir }
    : { kind: "workspace" };
}

export function memoryScopeKey(scope: MemoryScope): string {
  return scope.kind === "project"
    ? `project:${scope.projectDir}`
    : `${scope.kind}:`;
}

export function episodicScopePrefix(scope: MemoryScope): string {
  if (scope.kind === "project") {
    return `${AI_MEMORY_PATH_PREFIX}/episodic/project/${encodeSegment(scope.projectDir)}`;
  }
  return `${AI_MEMORY_PATH_PREFIX}/episodic/${scope.kind}/_`;
}

export function episodicMemoryPath(
  scope: MemoryScope,
  conversationId: string,
  entryId: string,
): string {
  return `${episodicScopePrefix(scope)}/${encodeSegment(conversationId)}/${encodeSegment(entryId)}`;
}

export function curatedScopePrefix(scope: MemoryScope): string {
  if (scope.kind === "project") {
    return `${AI_MEMORY_PATH_PREFIX}/curated/project/${encodeSegment(scope.projectDir)}`;
  }
  return `${AI_MEMORY_PATH_PREFIX}/curated/${scope.kind}/_`;
}

export function curatedMemoryPath(
  scope: MemoryScope,
  memoryId: string,
): string {
  return `${curatedScopePrefix(scope)}/${encodeSegment(memoryId)}`;
}

export function currentMemoryScopes(scopeDir: string): MemoryScope[] {
  const scopes: MemoryScope[] = [{ kind: "user" }, { kind: "workspace" }];
  if (!scopeDir) return scopes;
  const segments = scopeDir.split("/");
  const projects: MemoryScope[] = [];
  for (
    let index = segments.length;
    index > 0 && projects.length < 8;
    index -= 1
  ) {
    projects.push({
      kind: "project",
      projectDir: segments.slice(0, index).join("/"),
    });
  }
  return [...scopes, ...projects];
}

export function scopeProximity(
  scope: MemoryScope,
  currentScopeDir: string,
): number {
  if (scope.kind === "user") return 0.75;
  if (scope.kind === "workspace") return currentScopeDir ? 0.8 : 1;
  if (scope.projectDir === currentScopeDir) return 1;
  if (!currentScopeDir.startsWith(`${scope.projectDir}/`)) return 0.35;
  const distance =
    currentScopeDir.split("/").length - scope.projectDir.split("/").length;
  return Math.max(0.45, 0.9 - distance * 0.08);
}
