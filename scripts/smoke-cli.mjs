import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const binary = resolve("artifacts/lapis-ai-controller");
const root = await mkdtemp(join(tmpdir(), "controller-smoke-"));
const configPath = join(root, "config.json");
const call = async (...args) =>
  JSON.parse(
    (
      await exec(binary, [...args, "--json", "--config", configPath], {
        timeout: 15_000,
      })
    ).stdout,
  );
let child;
async function start() {
  child = spawn(binary, ["serve", "--json", "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("Service startup timeout")),
      15_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Service exited ${code}`));
    });
    child.stdout.on("data", (data) => {
      text += data;
      if (text.includes('"event":"ready"')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const process = child;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      reject(new Error("Service shutdown timeout"));
    }, 10_000);
    process.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Service exited ${code}`));
    });
    process.kill("SIGTERM");
  });
}
try {
  assert.equal((await call("init", "--workspace", root)).ok, true);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  config.database = join(root, "controller.sqlite");
  config.port = port;
  await writeFile(configPath, JSON.stringify(config));
  await start();
  assert.equal((await call("status")).data.protocol, "lapis-ai-controller/1");
  assert.equal((await call("providers", "list")).data.length, 3);
  const thread = (
    await call(
      "threads",
      "create",
      "--provider",
      "codex",
      "--workspace",
      "default",
    )
  ).data;
  await stop();
  await start();
  assert.equal(
    (await call("threads", "show", "--thread", thread.id)).data.thread.id,
    thread.id,
  );
  console.log(
    "Compiled Deno CLI: init, authenticated service, providers, threads, restart and shutdown passed",
  );
} finally {
  await stop();
  await rm(root, { recursive: true, force: true });
}
