import { mkdir, readFile, realpath } from "node:fs/promises";
import {
  createAcpAgentRegistry,
  DEFAULT_ACP_AGENTS,
  parseAcpAgentDefinitions,
} from "@lapismd/ai-host";
import { ControllerError, type Principal } from "./contracts.js";
import { ControllerStore } from "./persistence/store.js";
import { Controller } from "./domain/engine.js";
import { AcpProvider } from "./execution/acp.js";
import { CodexProvider } from "./execution/codex.js";
import type { ExecutionProvider } from "./domain/ports.js";
import { serveController } from "./transport/server.js";
import type { ServiceConfig } from "./cli/config.js";
import { externalCommand } from "./execution/commands.js";
import { currentSelfInvocation } from "./cli/self.js";

export async function agentRegistry(path?: string) {
  const entries = path
    ? parseAcpAgentDefinitions(JSON.parse(await readFile(path, "utf8")))
    : DEFAULT_ACP_AGENTS;
  return createAcpAgentRegistry(
    await Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        command: await externalCommand(
          entry.command ??
            (entry.id === "codex"
              ? ["codex-acp"]
              : entry.id === "cursor"
                ? ["cursor-agent", "acp"]
                : [entry.id]),
        ),
      })),
    ),
  );
}
/** One service composition shared by the standalone and supervised executable. */
export async function startService(
  config: ServiceConfig,
  credentials: Array<{ token: string; principal: Principal }>,
) {
  const paths = new Set<string>();
  const workspaces: Record<string, string> = {};
  for (const [id, path] of Object.entries(config.workspaces)) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    if (paths.has(canonical))
      throw new ControllerError(
        "workspace_alias",
        "Each physical workspace must have exactly one configured identity",
      );
    paths.add(canonical);
    workspaces[id] = canonical;
  }
  const registry = await agentRegistry(config.agentConfig);
  const self = currentSelfInvocation();
  const shimCommand = {
    command: self.command,
    args: [...self.argsPrefix, "__internal", "mcp-shim"],
  };
  const providers = new Map<string, ExecutionProvider>(
    config.providers.map((provider) => [
      provider.id,
      provider.driver === "acp"
        ? new AcpProvider({
            id: provider.id,
            agent: provider.agent,
            workspaces,
            shimCommand,
            agentRegistry: registry,
          })
        : new CodexProvider(workspaces, { id: provider.id, shimCommand }),
    ]),
  );
  const store = new ControllerStore(config.database);
  const controller = new Controller(store, providers);
  try {
    const server = await serveController(controller, {
      credentials,
      bind: config.bind,
      port: config.port,
    });
    controller.start();
    return {
      url: server.url,
      async close() {
        await server.close();
        await controller.close();
        store.close();
      },
    };
  } catch (error) {
    await controller.close();
    store.close();
    throw error;
  }
}
