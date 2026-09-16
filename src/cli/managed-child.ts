import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { ControllerError } from "../contracts.js";
import type { ManagedReady, ManagedStartRequest } from "../managed.js";
import { agentRegistry, startService } from "../service.js";
import type { ServiceConfig } from "./config.js";

export async function runManagedChild(): Promise<void> {
  process.umask(0o077);
  const lines = createInterface({ input: process.stdin });
  let request: ManagedStartRequest | undefined;
  for await (const line of lines) {
    if (line.length > 1_000_000)
      throw new ControllerError("invalid_startup", "Startup frame too large");
    request = JSON.parse(line) as ManagedStartRequest;
    break;
  }
  lines.close();
  if (
    !request ||
    request.schema !== "lapis-ai-controller.managed/1" ||
    typeof request.token !== "string" ||
    request.token.length < 32 ||
    typeof request.workspace !== "string" ||
    !isAbsolute(request.workspace) ||
    typeof request.database !== "string" ||
    !isAbsolute(request.database) ||
    !["127.0.0.1", "::1"].includes(request.bind) ||
    !Number.isInteger(request.port) ||
    request.port < 0 ||
    request.port > 65535 ||
    (request.agentConfig !== undefined &&
      (typeof request.agentConfig !== "string" ||
        !isAbsolute(request.agentConfig)))
  )
    throw new ControllerError(
      "invalid_startup",
      "Invalid private startup request",
    );
  const registry = await agentRegistry(request.agentConfig);
  const providers: ServiceConfig["providers"] = registry
    .list()
    .map((agent) => ({ id: agent.id, agent: agent.id, driver: "acp" }));
  if (!providers.some((provider) => provider.id === "codex-native"))
    providers.push({
      id: "codex-native",
      agent: "codex",
      driver: "codex-native",
    });
  const principal = {
    id: "managed",
    providers: providers.map((provider) => provider.id),
    workspaces: ["default"],
  };
  const config: ServiceConfig = {
    schema: "lapis-ai-controller.config/1",
    bind: request.bind,
    port: request.port,
    database: request.database,
    workspaces: { default: request.workspace },
    providers,
    credentials: [],
    ...(request.agentConfig ? { agentConfig: request.agentConfig } : {}),
  };
  const running = await startService(config, [
    { token: request.token, principal },
  ]);
  const ready: ManagedReady = {
    schema: "lapis-ai-controller.ready/1",
    url: running.url,
    workspace: "default",
  };
  process.stdout.write(JSON.stringify(ready) + "\n");
  try {
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        resolve();
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  } finally {
    await running.close();
  }
}
