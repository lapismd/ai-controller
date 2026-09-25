import type { ControllerMemoryHost } from "./memory-host.js";
import type { StoredSearchDocument } from "./store-port.js";

export function drainEmbeddings(host: ControllerMemoryHost): void {
  if (!host.embedding || host.embeddingDrain || host.embeddingStopped) return;
  host.embeddingDrain = runEmbeddingQueue(host)
    .catch(() => {
      // The durable pending-document query is the recovery source. A failed
      // capture boundary cannot safely record another error or retry a batch.
      host.embeddingStopped = true;
      host.embeddingQueue.clear();
    })
    .finally(() => {
      host.embeddingDrain = undefined;
      if (host.embeddingQueue.size) drainEmbeddings(host);
    });
}

export async function runEmbeddingQueue(
  host: ControllerMemoryHost,
): Promise<void> {
  while (host.embedding && !host.embeddingStopped && host.embeddingQueue.size) {
    const ids = [...host.embeddingQueue].slice(0, 16);
    ids.forEach((id) => host.embeddingQueue.delete(id));
    const documents = ids
      .map((id) => host.store.searchDocument(id))
      .filter((item): item is StoredSearchDocument => Boolean(item));
    if (!documents.length) continue;
    try {
      const vectors = await host.embedding.embed(
        documents.map(({ content }) => content),
      );
      if (host.embeddingStopped) return;
      for (const [index, document] of documents.entries()) {
        const vector = vectors[index];
        if (!vector?.length) throw new Error("Embedding result is missing");
        host.store.putSearchEmbedding({
          documentId: document.documentId,
          modelId: host.embedding.modelId,
          modelRevision: host.embedding.modelRevision,
          contentHash: document.contentHash,
          vector,
          updatedAt: host.now(),
        });
      }
    } catch {
      if (host.embeddingStopped) return;
      for (const document of documents)
        host.store.putSearchEmbeddingError({
          documentId: document.documentId,
          modelId: host.embedding.modelId,
          modelRevision: host.embedding.modelRevision,
          contentHash: document.contentHash,
          error: "embedding_failed",
          updatedAt: host.now(),
        });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}
