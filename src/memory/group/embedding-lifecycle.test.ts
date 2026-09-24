import { expect, it, vi } from "vitest";
import { ControllerMemoryService } from "./service.js";
import type { MemoryStorePort, StoredSearchDocument } from "./store-port.js";

const document = { documentId: "one", content: "safe evidence", contentHash: "hash" } as StoredSearchDocument;

for (const failure of ["read", "write"] as const) {
  it(`contains a capture failure during background embedding ${failure} without retrying or exposing input`, async () => {
    const captureFailure = new Error("capture_rejected");
    let reads = 0;
    const write = vi.fn();
    const errorWrite = vi.fn();
    const store = {
      pruneEvidence: () => [], allEvidence: () => [], memories: () => [],
      invalidateSearchEmbeddings: () => 0,
      pendingSearchDocuments: () => [document, { ...document, documentId: "two" }],
      searchDocument: () => { reads++; return document; },
      putSearchEmbedding: write,
      putSearchEmbeddingError: errorWrite,
    } as unknown as MemoryStorePort;
    const embed = vi.fn(async () => [[1], [1]]);
    let rejected = false;
    const memory = new ControllerMemoryService(store, {
      enabled: true, historyRetentionDays: 30, backfillDays: 7,
      embeddings: { enabled: true, modelId: "test" },
    }, {
      embeddingProvider: { modelId: "test", modelRevision: "1", embed, close: async () => {} },
      capture: {
        clean<T>(value: T): T {
          if (rejected || (value === document && failure === "read") || (value && typeof value === "object" && "vector" in value && failure === "write")) {
            rejected = true;
            throw captureFailure;
          }
          return value;
        },
        close() {},
      },
    });
    memory.start();
    // A background rejection must be handled before the next event-loop turn,
    // rather than only when application shutdown eventually awaits close().
    await new Promise((resolve) => setTimeout(resolve, 20));
    await memory.close();
    expect(reads).toBe(failure === "read" ? 1 : 2);
    expect(embed).toHaveBeenCalledTimes(failure === "read" ? 0 : 1);
    expect(write).not.toHaveBeenCalled();
    expect(errorWrite).not.toHaveBeenCalled();
  });
}

it("stops queued embeddings before disposing capture during close", async () => {
  let finish!: (vectors: number[][]) => void;
  const embed = vi.fn(() => new Promise<number[][]>((resolve) => { finish = resolve; }));
  const write = vi.fn();
  const captureClose = vi.fn();
  const store = {
    pruneEvidence: () => [], allEvidence: () => [], memories: () => [],
    invalidateSearchEmbeddings: () => 0,
    pendingSearchDocuments: () => Array.from({ length: 20 }, (_, index) => ({ ...document, documentId: String(index) })),
    searchDocument: () => document, putSearchEmbedding: write, putSearchEmbeddingError: write,
  } as unknown as MemoryStorePort;
  const memory = new ControllerMemoryService(store, {
    enabled: true, historyRetentionDays: 30, backfillDays: 7,
    embeddings: { enabled: true, modelId: "test" },
  }, {
    embeddingProvider: { modelId: "test", modelRevision: "1", embed, close: async () => { finish(Array.from({ length: 16 }, () => [1])); } },
    capture: { clean: <T>(value: T) => value, close: captureClose },
  });
  memory.start();
  await memory.close();
  expect(embed).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  expect(captureClose).toHaveBeenCalledTimes(1);
});
