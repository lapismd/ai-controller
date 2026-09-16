import { describe, expect, it, vi } from "vitest";
import {
  recallMemory,
  type MemoryCandidate,
  type MemoryPort,
} from "./recall.js";
import { selectMmr, tokenSimilarity, automaticRecallQuery } from "./ranking.js";
const candidate = (
  ref: string,
  content = "Use compact headings",
): MemoryCandidate => ({
  ref,
  content,
  revision: "1",
  origin: "owner",
  active: true,
  curated: true,
  provenance: ["conversation/entry"],
});
describe("extracted memory policy", () => {
  it("preserves profile ranking and automatic query normalization", () => {
    expect(
      automaticRecallQuery("Could you please use compact headings with Atlas?"),
    ).toBe("you compact headings atlas");
    expect(tokenSimilarity("", "")).toBe(1);
    expect(tokenSimilarity("", "", "zero")).toBe(0);
    const candidates = [
      { score: 1, text: "compact headings" },
      { score: 0.9, text: "compact headings" },
      { score: 0.8, text: "keep source code" },
    ];
    expect(
      selectMmr(candidates, 2, {
        score: (item) => item.score,
        text: (item) => item.text,
      }),
    ).toEqual([candidates[0], candidates[2]]);
  });
  it("keeps owner evidence, provenance, three records and the existing Lapis budget", async () => {
    const items = [
      candidate("huge", "x".repeat(4000)),
      { ...candidate("untrusted"), origin: "untrusted" as const },
      ...["a", "b", "c", "d"].map((id) => candidate(id)),
    ];
    const port: MemoryPort = {
      profile: "lapis-v1",
      candidates: async () => items,
      authorize: async (selected) =>
        selected.every((item) => !["untrusted", "huge"].includes(item.ref)),
    };
    const result = await recallMemory(port, "headings");
    expect(result.blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
    expect(result.blocks[0]?.content).toBe(
      "Use compact headings\nProvenance: conversation/entry",
    );
  });
  it("bounds optional retrieval and rechecks revoked evidence", async () => {
    vi.useFakeTimers();
    try {
      const slow = recallMemory(
        {
          profile: "lapis-v1",
          candidates: () => new Promise(() => {}),
          authorize: async () => true,
        },
        "query",
      );
      await vi.advanceTimersByTimeAsync(150);
      expect((await slow).omitted).toBe("deadline");
    } finally {
      vi.useRealTimers();
    }
    expect(
      (
        await recallMemory(
          {
            profile: "nostr-v1",
            candidates: async () => [candidate("a")],
            authorize: async () => false,
          },
          "query",
        )
      ).blocks,
    ).toEqual([]);
  });
});
