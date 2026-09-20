import { expect, it } from "vitest";
import { capturedMemoryStore } from "./capture-store.js";
import { CaptureBoundary } from "../../capture/boundary.js";
import type { MemoryStorePort } from "./store-port.js";
it("scans memory writes and legacy reads before an index or embedding can receive them", () => {
  const secret = "synthetic-memory-canary-732";
  const boundary = new CaptureBoundary({ secrets: [secret], roots: [{ kind: "workspace", id: "probe", path: "/private/test/workspace" }] });
  const writes: unknown[] = [];
  const raw = { upsertSearchDocument: (d: unknown) => { writes.push(d); }, searchDocument: () => ({ content: `${secret} /private/test/workspace/README` }), putEvidence: (d: unknown) => { writes.push(d); return true; } } as unknown as MemoryStorePort;
  const store = capturedMemoryStore(raw, boundary);
  try {
    store.upsertSearchDocument({ content: `${secret} /private/test/workspace/README` } as never);
    expect(JSON.stringify(writes)).not.toContain(secret);
    expect(JSON.stringify(writes)).not.toContain("/private/test");
    expect(store.searchDocument("record")?.content).toBe("[REDACTED] $WORKSPACE[probe]/README");
    expect(() => store.putEvidence({ event: { sig: "original-signature", content: secret } } as never)).toThrow("Verified evidence");
    expect(writes).toHaveLength(1);
  } finally { boundary.close(); }
});
