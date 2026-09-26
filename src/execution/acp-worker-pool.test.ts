import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpWorkerPool } from "./acp-worker-pool.js";

afterEach(() => vi.useRealTimers());

describe("ACP worker residency", () => {
  it("evicts the least recently used idle connection at the global limit", async () => {
    let clock = 0;
    const closed: string[] = [];
    const pool = new AcpWorkerPool(2, 60_000, () => ++clock);
    await pool.reserve("codex:a", async () => { closed.push("a"); });
    pool.release("codex:a", true);
    await pool.reserve("cursor:b", async () => { closed.push("b"); });
    pool.release("cursor:b", true);
    await pool.reserve("codex:a", async () => { closed.push("a"); });
    pool.release("codex:a", true);
    await pool.reserve("opencode:c", async () => { closed.push("c"); });
    expect(closed).toEqual(["b"]);
    pool.close();
  });

  it("waits for a busy worker rather than evicting an active turn", async () => {
    const closed = vi.fn(async () => {});
    const pool = new AcpWorkerPool(1);
    await pool.reserve("one", closed);
    let acquired = false;
    const next = pool.reserve("two", closed).then(() => { acquired = true; });
    await Promise.resolve();
    expect(acquired).toBe(false);
    pool.release("one", true);
    await next;
    expect(closed).toHaveBeenCalledOnce();
    pool.close();
  });

  it("expires only idle connections after the configured duration", async () => {
    vi.useFakeTimers();
    const closed = vi.fn(async () => {});
    const pool = new AcpWorkerPool(1, 900_000);
    await pool.reserve("one", closed);
    await vi.advanceTimersByTimeAsync(900_001);
    expect(closed).not.toHaveBeenCalled();
    pool.release("one", true);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(closed).toHaveBeenCalledOnce();
    pool.close();
  });

  it("abandons a waiting reservation when its turn is cancelled", async () => {
    const pool = new AcpWorkerPool(1);
    await pool.reserve("one", async () => {});
    const abort = new AbortController();
    const waiting = pool.reserve("two", async () => {}, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    pool.release("one", false);
    pool.close();
  });
});
