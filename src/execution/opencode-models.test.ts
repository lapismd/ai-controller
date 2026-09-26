import { describe, expect, it, vi } from "vitest";
import type { OpenCodeServer } from "./opencode-server.js";
import { OpenCodeProvider } from "./opencode.js";

describe("OpenCode Native model discovery", () => {
  it("lists models only from connected OpenCode providers", async () => {
    const disconnectedModels = Object.fromEntries(
      Array.from({ length: 8_000 }, (_, index) => [`model-${index}`, { name: `Model ${index}` }]),
    );
    const server = {
      json: vi.fn(async () => ({
        connected: ["configured"],
        all: [
          { id: "configured", models: { fast: { name: "Fast" }, precise: { name: "Precise" } } },
          { id: "catalogue", models: disconnectedModels },
        ],
      })),
      close: vi.fn(async () => {}),
    } as unknown as OpenCodeServer;
    const provider = new OpenCodeProvider({ root: "/tmp/opencode-probe" }, async () => server);

    await expect(provider.models("root")).resolves.toEqual({
      agent: "opencode-native",
      models: ["configured/fast", "configured/precise"],
      entries: [
        { id: "configured/fast", label: "Fast" },
        { id: "configured/precise", label: "Precise" },
      ],
      configOptions: [],
    });
    expect(server.json).toHaveBeenCalledWith("/provider", "GET");
    await provider.close();
  });
});
