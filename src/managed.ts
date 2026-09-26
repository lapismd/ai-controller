import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { ControllerError } from "./contracts.js";
import { SynchronousRedaction } from "@lapismd/agent-redaction/node";

export const MANAGED_CONTROLLER_READY_TIMEOUT_MS = 60_000;

export interface ManagedControllerOptions {
  workspace: string;
  database: string;
  agentConfig?: string;
  bind?: "127.0.0.1" | "::1";
  port?: number;
  /** Explicit environment. Applications must exclude domain signing credentials. */
  env: NodeJS.ProcessEnv;
  executable?: { command: string; argsPrefix?: string[] };
  readyTimeoutMs?: number;
  redaction?: { environment?: string[]; dotenvFiles?: string[] };
  onLog?(line: string): void;
}
export interface ManagedStartRequest {
  schema: "lapis-ai-controller.managed/1";
  token: string;
  workspace: string;
  database: string;
  agentConfig?: string;
  bind: "127.0.0.1" | "::1";
  port: number;
  redaction?: { environment?: string[]; dotenvFiles?: string[] };
}
export interface ManagedReady {
  schema: "lapis-ai-controller.ready/1";
  url: string;
  workspace: "default";
  capturePolicy?: string;
  build?: { version: string; revision: string; builtAt: string };
}
/** Supervises the separate Deno executable. No execution engine is embedded here. */
export class ManagedControllerProcess {
  #stopping = false;
  private constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly connection: ManagedReady & { token: string },
  ) {}
  static async start(
    options: ManagedControllerOptions,
  ): Promise<ManagedControllerProcess> {
    const token = randomBytes(32).toString("base64url");
    const child = spawn(
      resolveManagedExecutable(
        options.executable?.command ?? "lapis-ai-controller",
        options.env,
      ),
      [...(options.executable?.argsPrefix ?? []), "__internal", "managed"],
      { env: options.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const request: ManagedStartRequest = {
      schema: "lapis-ai-controller.managed/1",
      token,
      workspace: options.workspace,
      database: options.database,
      ...(options.redaction ? { redaction: options.redaction } : {}),
      ...(options.agentConfig ? { agentConfig: options.agentConfig } : {}),
      bind: options.bind ?? "127.0.0.1",
      port: options.port ?? 0,
    };
    const lines = createInterface({ input: child.stdout });
    child.stderr.setEncoding("utf8");
    const diagnostics = new SynchronousRedaction({
      secrets: [token],
      roots: [{ kind: "workspace", id: "default", path: options.workspace }],
    });
    let stderr = "",
      diagnosticBytes = 0,
      diagnosticOverflow = false;
    child.stderr.on("data", (chunk: string) => {
      diagnosticBytes += Buffer.byteLength(chunk);
      if (diagnosticBytes > 2 * 1024 * 1024) {
        stderr = "";
        diagnosticOverflow = true;
      } else if (!diagnosticOverflow) stderr += chunk;
    });
    child.stderr.once("end", () => {
      try {
        if (diagnosticOverflow)
          options.onLog?.(
            "Controller diagnostic output omitted: limit_exceeded",
          );
        else if (stderr) {
          const result = diagnostics.text(stderr);
          options.onLog?.(
            result.status === "sanitized"
              ? result.value
              : "Controller diagnostic output omitted: scan_failed",
          );
        }
      } finally {
        stderr = "";
        diagnostics.dispose();
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onError!: (error: Error) => void;
    const ready = Promise.race([
      (async () => {
        for await (const line of lines) {
          if (line.length > 8192) throw new Error("Readiness frame too large");
          const value = JSON.parse(line) as ManagedReady;
          const url = new URL(value.url);
          if (
            value.schema !== "lapis-ai-controller.ready/1" ||
            value.workspace !== "default" ||
            url.protocol !== "ws:" ||
            !["127.0.0.1", "[::1]"].includes(url.hostname)
          )
            throw new Error("Invalid controller readiness");
          return value;
        }
        throw new Error("Controller exited before readiness");
      })(),
      new Promise<never>((_, reject) => {
        onError = () =>
          reject(
            new ControllerError(
              "controller_unavailable",
              "Controller executable could not start",
            ),
          );
        child.once("error", onError);
        timer = setTimeout(
          () =>
            reject(
              new ControllerError(
                "controller_timeout",
                "Controller readiness timed out",
              ),
            ),
          options.readyTimeoutMs ?? MANAGED_CONTROLLER_READY_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    void ready.catch(() => undefined);
    try {
      await waitForSpawn(child);
      await writeManagedStart(child.stdin, request);
      const frame = await ready;
      return new ManagedControllerProcess(child, { ...frame, token });
    } catch (error) {
      child.kill("SIGKILL");
      const detail = error instanceof Error ? error.message : "startup failed";
      throw new ControllerError(
        "controller_start_failed",
        `Could not start the separate lapis-ai-controller executable: ${detail}`,
      );
    } finally {
      clearTimeout(timer);
      child.off("error", onError);
      lines.close();
    }
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void {
    this.child.once("exit", (code, signal) => {
      if (!this.#stopping) listener(code, signal);
    });
  }
  async close(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      this.child.once("exit", () => resolve()),
    );
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
    timer.unref?.();
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
export function resolveManagedExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
): string {
  if (command.includes("/") || command.includes("\\")) return command;
  for (const root of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(root, command);
    if (existsSync(candidate)) return candidate;
  }
  const home = env.HOME?.trim();
  if (home) {
    const fallback = join(home, ".local", "bin", command);
    if (existsSync(fallback)) return fallback;
  }
  return command;
}
export function waitForSpawn(child: {
  pid?: number;
  once(event: "spawn" | "error", listener: (error?: Error) => void): void;
}): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", () =>
      reject(
        new ControllerError(
          "controller_unavailable",
          "Controller executable could not start",
        ),
      ),
    );
  });
}

export async function writeManagedStart(
  input: Writable,
  request: ManagedStartRequest,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(
        new ControllerError(
          "controller_input_closed",
          "Controller input closed before startup",
        ),
      );
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      input.off("error", fail);
      resolve();
    };
    input.once("error", fail);
    input.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error) fail();
      else succeed();
    });
  });
}
