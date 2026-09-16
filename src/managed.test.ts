import { expect, it } from "vitest";
import { Writable } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { ControllerClient } from "./client.js";
import {
  ManagedControllerProcess,
  writeManagedStart,
  type ManagedStartRequest,
} from "./managed.js";

it("contains a failed startup pipe and a missing executable without exposing credentials", async () => {
  const input = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("EPIPE"));
    },
  });
  const request: ManagedStartRequest = {
    schema: "lapis-ai-controller.managed/1",
    token: "x".repeat(32),
    workspace: "/tmp/test",
    database: "/tmp/test.sqlite",
    bind: "127.0.0.1",
    port: 0,
  };
  await expect(writeManagedStart(input, request)).rejects.toMatchObject({
    code: "controller_input_closed",
  });
  await expect(
    ManagedControllerProcess.start({
      ...request,
      env: {},
      executable: { command: "/nonexistent/controller" },
    }),
  ).rejects.toMatchObject({ code: "controller_start_failed" });
});

it("launches a separate service with stdin credentials and reopens durable threads after restart", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local", "managed-test-"));
  const entry = join(dir, "main.mjs");
  await build({
    entryPoints: ["src/main.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const options = {
    workspace: join(dir, "workspace"),
    database: join(dir, "controller.sqlite"),
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    executable: { command: process.execPath, argsPrefix: [entry] },
  };
  let child: ManagedControllerProcess | undefined;
  let client: ControllerClient | undefined;
  try {
    child = await ManagedControllerProcess.start(options);
    expect(child.pid).not.toBe(process.pid);
    expect(child.child.spawnargs.join(" ")).not.toContain(
      child.connection.token,
    );
    client = new ControllerClient(child.connection);
    const thread = await client.createThread({
      provider: "codex",
      workspace: "default",
    });
    client.dispose();
    await child.close();
    child = await ManagedControllerProcess.start(options);
    client = new ControllerClient(child.connection);
    expect((await client.snapshot(thread.id)).thread.id).toBe(thread.id);
  } finally {
    client?.dispose();
    await child?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
