import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OpenCode port unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Owns one authenticated loopback OpenCode process. The password never enters logs. */
export class OpenCodeServer {
  private constructor(
    readonly child: ChildProcess,
    readonly url: string,
    readonly password: string,
    readonly workspace: string,
  ) {}

  static async start(workspace: string, command = "opencode"): Promise<OpenCodeServer> {
    const port = await freeLoopbackPort();
    const password = randomBytes(32).toString("base64url");
    const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    const server = new OpenCodeServer(child, `http://127.0.0.1:${port}`, password, workspace);
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null) throw new Error("OpenCode exited during startup");
        try {
          const response = await server.request("/global/health", { method: "GET" });
          if (response.ok) return server;
        } catch { /* Wait for the listener. */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("OpenCode server startup timed out");
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  async request(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.url);
    url.searchParams.set("directory", this.workspace);
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`OpenCode API ${response.status}: ${url.pathname}`);
    return response;
  }

  async json<T>(path: string, method: string, body?: unknown): Promise<T> {
    const response = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return await response.json() as T;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}
