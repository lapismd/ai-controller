import { describe, expect, it } from "vitest";
import { NativeMemoryService } from "./native-memory-service.js";
import { RedactionScope } from "@lapismd/agent-redaction";
import { MemoryCaptureBoundary } from "./capture-port.js";
import { InMemoryMemoryRecordStore } from "./memory-record-store.js";
import type { ConversationSnapshot } from "./conversation-types.js";
import type {
  MemoryDatabase,
  MemoryDatabaseMemoryCandidateInput,
  MemoryDatabaseMemorySourceRecord,
  SearchDocumentRecord,
} from "./database-port.js";
function databaseFixture(): MemoryDatabase {
  const docs = new Map<string, SearchDocumentRecord>();
  const sources = new Map<string, MemoryDatabaseMemorySourceRecord>();
  const candidates = new Map<string, MemoryDatabaseMemoryCandidateInput>();
  const meta = new Map<string, unknown>();
  return {
    beginSearchIndexingBatch: async () => {},
    endSearchIndexingBatch: async () => {},
    getMeta: async <T>(key: string) => meta.get(key) as T | undefined,
    setMeta: async (key, value) => {
      meta.set(key, value);
    },
    upsertSearchDocument: async (doc) => {
      docs.set(doc.path, doc);
    },
    getSearchDocument: async (path) => docs.get(path),
    deleteSearchDocument: async (path) => {
      docs.delete(path);
    },
    listSearchDocuments: async () => [...docs.values()],
    searchDocuments: async (query, options) =>
      [...docs.values()]
        .filter(
          (doc) =>
            (!options?.pathPrefix ||
              doc.path === options.pathPrefix ||
              doc.path.startsWith(`${options.pathPrefix}/`)) &&
            (!options?.sourceProviderIds ||
              options.sourceProviderIds.includes(doc.sourceProviderId ?? "")) &&
            query
              .split(" ")
              .some((token) => doc.content.toLowerCase().includes(token)),
        )
        .slice(0, options?.limit ?? 20)
        .map((document) => ({
          document,
          score: 1,
          snippets: [
            {
              field: "content",
              text: document.chunks?.[0]?.text ?? document.content,
            },
          ],
        })),
    getMemorySourceState: async (id) => sources.get(id),
    listMemorySourceStates: async () => [...sources.values()],
    upsertMemorySourceState: async (item) => {
      sources.set(item.sourceKey, item);
    },
    deleteMemorySourceState: async (id) => {
      sources.delete(id);
    },
    upsertMemoryCandidate: async (item) => {
      candidates.set(item.candidate.id, item);
    },
    queryMemoryCandidates: async (query) =>
      [...candidates.values()]
        .filter(
          (item) =>
            (!query?.scopeKind ||
              query.scopeKind === item.candidate.scopeKind) &&
            (query?.scopePath === undefined ||
              query.scopePath === item.candidate.scopePath) &&
            (!query?.states || query.states.includes(item.candidate.state)),
        )
        .slice(0, query?.limit ?? 1000),
    deleteMemoryCandidatesByConversation: async (id) => {
      for (const [key, item] of candidates)
        if (item.origins.some((origin) => origin.conversationId === id))
          candidates.delete(key);
    },
    recordMemoryRecallSignal: async () => {},
    claimMemoryJob: async () => null,
    updateMemoryJob: async () => null,
  };
}
describe("extracted schema-1 memory", () => {
  it("sanitizes before the first index write and rescans legacy reads without changing execution locations", async () => {
    const secret = "synthetic-lapis-memory-private-material";
    const scope = new RedactionScope({ roots: [{ kind: "workspace", id: "demo", path: "/private/demo" }] });
    scope.registerSecrets([secret]);
    const capture = new MemoryCaptureBoundary(scope);
    const writes: unknown[] = [];
    const raw = { content: `${secret} /private/demo/README`, location: { scopeDir: "Projects/Demo", conversationId: "conversation" } };
    const storage = capture.port({
      async put(value: unknown) { writes.push(value); },
      async read() { return raw; },
    });
    await storage.put(raw);
    expect(JSON.stringify(writes)).not.toContain(secret);
    expect(JSON.stringify(writes)).not.toContain("/private/demo");
    expect(JSON.stringify(writes)).toContain("$WORKSPACE[demo]/README");
    expect(await storage.read()).toEqual(writes[0]);
    const executionArgs: unknown[] = [];
    const execution = capture.port({ async read(location: string) { executionArgs.push(location); return raw; } }, true);
    await execution.read("/private/demo/conversation");
    expect(executionArgs).toEqual(["/private/demo/conversation"]);
    expect(raw.content).toContain(secret);
    const malformed: unknown[] = [];
    Object.defineProperty(malformed, "0", { get() { throw new Error("getter executed"); } });
    await expect(storage.put(malformed)).rejects.toThrow("memory_capture_invalid");
    expect(writes).toHaveLength(1);
  });
  it("preserves ingestion, evidence promotion, recall and forget exclusions without writing the transcript", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const now = "2026-08-27T12:00:00.000Z";
    const snapshot: ConversationSnapshot = {
      location: { conversationId: id, scopeDir: "Projects/Atlas" },
      metadata: {
        id,
        schemaVersion: 3,
        createdAt: now,
        updatedAt: now,
        status: "active",
      },
      agents: [],
      warnings: [],
      transcript: [
        {
          schemaVersion: 3,
          id: "user-1",
          type: "message",
          role: "user",
          text: "Remember that project Atlas uses compact headings.",
          createdAt: now,
        },
      ],
    };
    const original = structuredClone(snapshot);
    const database = databaseFixture();
    const records = new InMemoryMemoryRecordStore();
    const memory = new NativeMemoryService(
      {
        listAll: async () => [{ location: snapshot.location }],
        read: async () => snapshot,
      },
      database,
      { recordStore: records, now: () => new Date(now) },
    );
    await memory.ingestConversation(snapshot.location);
    const result = await memory.consolidate({
      kind: "project",
      projectDir: "Projects/Atlas",
    });
    expect(result.written).toBe(1);
    expect((await records.list())[0]?.record.revision).toBe(1);
    const recalled = await memory.recall("compact headings Atlas", {
      scopeDir: "Projects/Atlas",
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.content).toContain(`${id}/user-1`);
    expect(
      await memory.recall("compact headings Atlas", {
        scopeDir: "Projects/Other",
      }),
    ).toEqual([]);
    await memory.forgetConversation(snapshot.location);
    await memory.rebuild();
    expect(
      await memory.recall("compact headings Atlas", {
        scopeDir: "Projects/Atlas",
      }),
    ).toEqual([]);
    expect(snapshot).toEqual(original);
    expect(await records.listExcludedConversationIds()).toEqual(new Set([id]));
  });
});
