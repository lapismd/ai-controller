import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, COMMANDS, markdownHelp } from "./commands.js";
import { runCli } from "./main.js";
import { human } from "./output.js";
import { initialize } from "./config.js";
import { ControllerStore } from "../persistence/store.js";
import { Controller } from "../domain/engine.js";
import { serveController } from "../transport/server.js";
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

it("runs management commands against the authenticated service with machine-readable results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "controller-management-"));
  const path = join(dir, "config.json");
  const config = await initialize(path, dir);
  const token = (await readFile(join(dir, "token"), "utf8")).trim();
  const store = new ControllerStore(":memory:");
  const controller = new Controller(
    store,
    new Map([
      [
        "codex",
        {
          capabilities: {
            driver: "fake",
            content: ["text" as const],
            configuration: true,
            resume: "context" as const,
            approvals: true,
            input: false,
            tools: true,
          },
          models: async () => [{ id: "fixture-model" }],
          execute: async (c) => {
            await c.emit({ type: "completed" });
          },
          close: async () => {},
        },
      ],
    ]),
  );
  const server = await serveController(controller, {
    credentials: [{ token, principal: config.credentials[0]!.principal }],
  });
  config.port = Number(new URL(server.url).port);
  await writeFile(path, JSON.stringify(config));
  async function invoke(args: string[]) {
    const output: string[] = [];
    const code = await runCli(
      [...args, "--config", path, "--json", "--color", "always"],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
      },
    );
    expect(output.join("\n")).not.toContain("\u001b");
    expect(code).toBe(0);
    return JSON.parse(output[0]!).data;
  }
  try {
    const thread = await invoke([
      "threads",
      "create",
      "--provider",
      "codex",
      "--workspace",
      "default",
    ]);
    expect(
      await invoke([
        "providers",
        "models",
        "--provider",
        "codex",
        "--workspace",
        "default",
      ]),
    ).toEqual([{ id: "fixture-model" }]);
    expect(
      (
        await invoke([
          "threads",
          "configure",
          "--thread",
          thread.id,
          "--expected-version",
          String(thread.version),
          "--configuration",
          '{"model":"fixture-model"}',
        ])
      ).configuration.model,
    ).toBe("fixture-model");
    expect(
      await invoke(["interactions", "list", "--thread", thread.id]),
    ).toEqual([]);
    expect(
      (await invoke(["tools", "list", "--thread", thread.id])).definitions,
    ).toEqual([]);
    const uncertain = store.accept(config.credentials[0]!.principal.id, {
      threadId: thread.id,
      commandId: "uncertain",
      text: "once",
    });
    store.transition(uncertain.turnId, "dispatching");
    store.recover();
    expect(() =>
      parseArgs([
        "turns",
        "resolve",
        "--turn",
        uncertain.turnId,
        "--outcome",
        "failed",
      ]),
    ).toThrow("--stopped");
    await invoke([
      "turns",
      "resolve",
      "--turn",
      uncertain.turnId,
      "--outcome",
      "failed",
      "--stopped",
    ]);
    expect(store.turn(uncertain.turnId)?.state).toBe("failed");
    expect(store.turns(thread.id)).toHaveLength(1);
    const snapshot = await invoke(["threads", "show", "--thread", thread.id]);
    expect(
      await invoke([
        "events",
        "read",
        "--thread",
        thread.id,
        "--after",
        snapshot.cursor,
      ]),
    ).toEqual([]);
  } finally {
    await server.close();
    await controller.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
