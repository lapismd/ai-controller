import { expect, it, vi } from "vitest";
import { externalCommand } from "./commands.js";
it("preserves multiline argv and avoids treating the compiled controller as a Node launcher", async () => {
  const script = "printf 'first\nsecond'\n";
  expect(await externalCommand(["/bin/sh", "-c", script])).toEqual([
    "/bin/sh",
    "-c",
    script,
  ]);
  vi.stubEnv("PATH", "");
  try {
    expect(await externalCommand(["missing-agent", script])).toBe(
      "'missing-agent' 'printf '\\''first\nsecond'\\''\n'",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
