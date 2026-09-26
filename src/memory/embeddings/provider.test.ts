import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativeEmbeddingLoader,
  NativeEmbeddingSession,
} from "./native-runtime.js";
import { LocalLlamaEmbeddingProvider } from "./provider.js";

const vector = () => Array.from({ length: 384 }, () => 0.25);

function session() {
  const value: NativeEmbeddingSession = {
    embed: vi.fn(async (texts) => texts.map(vector)),
    close: vi.fn(async () => undefined),
  };
  return value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LocalLlamaEmbeddingProvider", () => {
  it("loads only for the first non-empty embedding request", async () => {
    const loaded = session();
    const load: NativeEmbeddingLoader = vi.fn(async () => loaded);
    const provider = new LocalLlamaEmbeddingProvider({}, { load });

    expect(load).not.toHaveBeenCalled();
    await expect(provider.embed([])).resolves.toEqual([]);
    await expect(provider.embed(["memory"], "document")).resolves.toHaveLength(1);
    await provider.embed(["query"], "query");

    expect(load).toHaveBeenCalledTimes(1);
    expect(loaded.embed).toHaveBeenNthCalledWith(1, ["memory"], "document");
    expect(loaded.embed).toHaveBeenNthCalledWith(2, ["query"], "query");
    await provider.close();
  });

  it("unloads after inactivity and recreates the session on demand", async () => {
    vi.useFakeTimers();
    const sessions = [session(), session()];
    const load: NativeEmbeddingLoader = vi.fn(async () => sessions.shift()!);
    const provider = new LocalLlamaEmbeddingProvider(
      { idleTimeoutMs: 100 },
      { load },
    );

    await provider.embed(["first"]);
    await vi.advanceTimersByTimeAsync(99);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions).toHaveLength(1);

    await provider.embed(["second"]);
    expect(load).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  it("applies a cooldown after loading fails", async () => {
    let now = 10;
    const loaded = session();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("download failed"))
      .mockResolvedValueOnce(loaded) as NativeEmbeddingLoader;
    const provider = new LocalLlamaEmbeddingProvider(
      { retryCooldownMs: 60_000 },
      { load, now: () => now },
    );

    await expect(provider.embed(["first"])).rejects.toThrow("download failed");
    await expect(provider.embed(["second"])).rejects.toThrow("cooling down");
    expect(load).toHaveBeenCalledTimes(1);

    now += 60_000;
    await expect(provider.embed(["third"])).resolves.toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
    await provider.close();
  });

  it("rejects vectors with an unexpected model shape", async () => {
    const loaded = session();
    vi.mocked(loaded.embed).mockResolvedValueOnce([[1, 2]]);
    const provider = new LocalLlamaEmbeddingProvider(
      {},
      { load: async () => loaded },
    );

    await expect(provider.embed(["bad shape"])).rejects.toThrow("invalid vectors");
    await provider.close();
  });
});
