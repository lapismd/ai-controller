import { expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Duplex, Writable } from "node:stream";
import { build } from "esbuild";
import { ControllerClient } from "./client.js";
import {
  ManagedControllerProcess,
  resolveManagedExecutable,
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
      readyTimeoutMs: 200,
    }),
  ).rejects.toMatchObject({
    code: "controller_start_failed",
    message: expect.stringContaining("could not start"),
  });
});

it("resolves a start write after the writable flush without waiting for stdin close", async () => {
  const chunks: Buffer[] = [];
  const input = new Duplex({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    read() {},
  });
  const request: ManagedStartRequest = {
    schema: "lapis-ai-controller.managed/1",
    token: "x".repeat(32),
    workspace: "/tmp/test",
    database: "/tmp/test.sqlite",
    bind: "127.0.0.1",
    port: 0,
  };
  await expect(writeManagedStart(input, request)).resolves.toBeUndefined();
  expect(Buffer.concat(chunks).toString()).toContain(
    "lapis-ai-controller.managed/1",
  );
  expect(input.writableEnded).toBe(false);
});

it("includes the readiness cause when startup times out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "managed-timeout-"));
  try {
    await expect(
      ManagedControllerProcess.start({
        workspace: dir,
        database: join(dir, "controller.sqlite"),
        env: { PATH: process.env.PATH ?? "" },
        executable: {
          command: process.execPath,
          argsPrefix: ["-e", "setTimeout(() => {}, 30_000)"],
        },
        readyTimeoutMs: 50,
      }),
    ).rejects.toMatchObject({
      code: "controller_start_failed",
      message: expect.stringContaining("timed out"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 5_000);

it("resolves a bare executable from PATH and HOME/.local/bin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "managed-exec-"));
  const pathDir = join(dir, "bin");
  const homeBin = join(dir, "home", ".local", "bin");
  await mkdir(pathDir, { recursive: true });
  await mkdir(homeBin, { recursive: true });
  const pathBinary = join(pathDir, "lapis-ai-controller");
  const homeBinary = join(homeBin, "lapis-ai-controller");
  await writeFile(pathBinary, "");
  await writeFile(homeBinary, "");
  await chmod(pathBinary, 0o755);
  await chmod(homeBinary, 0o755);
  try {
    expect(
      resolveManagedExecutable("/explicit/lapis-ai-controller", {}),
    ).toBe("/explicit/lapis-ai-controller");
    expect(
      resolveManagedExecutable("lapis-ai-controller", { PATH: pathDir }),
    ).toBe(pathBinary);
    expect(
      resolveManagedExecutable("lapis-ai-controller", {
        HOME: join(dir, "home"),
      }),
    ).toBe(homeBinary);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
