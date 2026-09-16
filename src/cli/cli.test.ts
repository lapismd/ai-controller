import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, COMMANDS, markdownHelp } from "./commands.js";
import { runCli } from "./main.js";
import { human } from "./output.js";
describe("operator interface", () => {
  it("generates command help and rejects missing or unknown options", () => {
    for (const command of COMMANDS)
      expect(markdownHelp()).toContain(`## ${command.path}`);
    expect(() => parseArgs(["turns", "submit", "--thread", "a"])).toThrow(
      "--command",
    );
    expect(() => parseArgs(["status", "--colour", "never"])).toThrow(
      "Unknown option",
    );
    expect(parseArgs(["help", "threads"]).help).toBe(true);
  });
  it("initializes private config idempotently and never reveals tokens in diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "controller-cli-"));
    const path = join(dir, "config.json");
    const output: string[] = [];
    const io = {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    try {
      for (let i = 0; i < 2; i++)
        expect(
          await runCli(
            ["init", "--workspace", dir, "--config", path, "--json"],
            io,
          ),
        ).toBe(0);
      expect((await stat(join(dir, "token"))).mode & 0o077).toBe(0);
      const secret = (await readFile(join(dir, "token"), "utf8")).trim();
      expect(
        await runCli(
          ["doctor", "--config", path, "--json", "--color", "always"],
          io,
        ),
      ).toBe(0);
      expect(output.join("\n")).not.toContain(secret);
      expect(output.join("\n")).not.toContain("\u001b");
      for (const line of output)
        expect(JSON.parse(line).schema).toBe("lapis-ai-controller.cli/1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("separates scannable human output from errors in machine output", async () => {
    expect(
      human("turns show", { state: "running", cancelRequested: false }),
    ).toContain("Cancel Requested");
    const output: string[] = [];
    expect(
      await runCli(["typo", "--json"], {
        stdout: (text) => output.push(text),
        stderr: () => {
          throw new Error("unexpected stderr");
        },
      }),
    ).toBe(2);
    expect(JSON.parse(output[0]!).error.code).toBe("invalid_arguments");
  });
});
