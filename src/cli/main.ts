import { readFile } from "node:fs/promises";
import { ControllerClient } from "../client.js";
import { ControllerError } from "../contracts.js";
import { ControllerStore } from "../persistence/store.js";
import { Controller } from "../domain/engine.js";
import { AcpProvider } from "../execution/acp.js";
import { CodexProvider } from "../execution/codex.js";
import type { ExecutionProvider } from "../domain/ports.js";
import { serveController } from "../transport/server.js";
import { currentSelfInvocation } from "./self.js";
import {
  defaultConfigPath,
  initialize,
  readConfig,
  readToken,
  type ServiceConfig,
} from "./config.js";
import { helpText, parseArgs } from "./commands.js";
import * as service from "./service.js";
import { VERSION } from "./brand.js";
import { human } from "./output.js";

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}
export async function runCli(
  argv: string[],
  io: CliIo = {
    stdout: (text) => console.log(text),
    stderr: (text) => console.error(text),
  },
): Promise<number> {
  let client: ControllerClient | undefined;
  let color = false;
  const json = argv.includes("--json");
  const write = (command: string, data: unknown, event = false) =>
    io.stdout(
      json
        ? JSON.stringify({
            schema: "lapis-ai-controller.cli/1",
            ...(event ? { event: command } : { command, ok: true }),
            data,
          })
        : human(command, data, color),
    );
  try {
    const parsed = parseArgs(argv);
    const { command, options: o } = parsed;
    color =
      o.color === "always" ||
      (o.color !== "never" &&
        Boolean(process.stdout.isTTY) &&
        !process.env.NO_COLOR);
    if (o.version) {
      write("version", VERSION);
      return 0;
    }
    if (parsed.help) {
      write("help", helpText(command));
      return 0;
    }
    const path = String(o.config || defaultConfigPath());
    if (command === "init") {
      const config = await initialize(path, String(o.workspace));
      write(command, { config: path, workspace: config.workspaces.default });
      return 0;
    }
    const config = await readConfig(path);
    if (command === "config show") {
      write(command, config);
      return 0;
    }
    if (["doctor", "config validate"].includes(command)) {
      for (const credential of config.credentials)
        await readToken(credential.tokenFile);
      write(command, {
        valid: true,
        providers: config.providers.map((item) => item.id),
        database: config.database,
      });
      return 0;
    }
    if (command === "token show") {
      write(command, {
        token: await readToken(config.credentials[0]!.tokenFile),
      });
      return 0;
    }
    if (command.startsWith("service ")) {
      const definition = service.serviceDefinition(
        path,
        String(o.instance || "default"),
      );
      const action = {
        install: service.installService,
        start: service.startService,
        stop: service.stopService,
        restart: service.restartService,
        status: service.serviceStatus,
        uninstall: service.uninstallService,
      }[command.slice(8)];
      if (!action)
        throw new ControllerError(
          "invalid_command",
          "Unknown service operation",
        );
      write(command, await action(definition));
      return 0;
    }
    if (command === "logs") {
      const definition = service.serviceDefinition(
        path,
        String(o.instance || "default"),
      );
      if (!definition.logPath)
        throw new ControllerError(
          "use_journal",
          `Use journalctl --user -u ${definition.id}`,
        );
      let count = 0;
      do {
        const lines = (await readFile(definition.logPath, "utf8"))
          .trim()
          .split("\n");
        for (const line of lines.slice(count)) {
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            write(
              "log",
              {
                event: entry.event,
                data: entry.event === "ready" ? entry.data : undefined,
              },
              true,
            );
          } catch {
            /* Only structured service records are displayed. */
          }
        }
        count = lines.length;
        if (o.follow) await delay(1000);
      } while (o.follow);
      return 0;
    }
    if (command === "serve") {
      await runService(config, (event, data) => write(event, data, true));
      return 0;
    }
    client = new ControllerClient({
      url: `ws://${config.bind === "::1" ? "[::1]" : config.bind}:${config.port}`,
      token: await readToken(config.credentials[0]!.tokenFile),
    });
    if (command === "status") {
      do {
        write(command, await client.request("system.status"), Boolean(o.watch));
        if (o.watch) await delay(1000);
      } while (o.watch);
      return 0;
    }
    if (command === "events watch") {
      await client.subscribe(String(o.thread), (snapshot, event) =>
        write(event?.type ?? "snapshot", event ?? snapshot, true),
      );
      await stopped();
      return 0;
    }
    const request = commandRequest(command, o);
    write(command, await client.request(request.method, request.params));
    return 0;
  } catch (error) {
    const code =
      error instanceof ControllerError ? error.code : "invalid_arguments";
    const message =
      error instanceof ControllerError ||
      (error instanceof Error &&
        /^Unknown |requires |--|.* requires --/.test(error.message))
        ? (error as Error).message
        : "Command failed; check configuration and service availability";
    if (json)
      io.stdout(
        JSON.stringify({
          schema: "lapis-ai-controller.cli/1",
          ok: false,
          error: { code, message },
        }),
      );
    else io.stderr(`Error [${code}]: ${message}`);
    return ["disconnected", "connection_failed", "connection_timeout"].includes(
      code,
    )
      ? 3
      : 2;
  } finally {
    client?.dispose();
  }
}
function commandRequest(
  command: string,
  o: Record<string, string | boolean>,
): { method: string; params: unknown } {
  switch (command) {
    case "providers list":
      return { method: "providers.list", params: {} };
    case "threads list":
      return { method: "threads.list", params: {} };
    case "threads create":
      return {
        method: "threads.create",
        params: {
          provider: o.provider,
          workspace: o.workspace,
          payloadPolicy: o.private ? "metadata-only" : "durable",
        },
      };
    case "threads show":
      return { method: "threads.snapshot", params: { threadId: o.thread } };
    case "turns submit":
      return {
        method: "turns.submit",
        params: { threadId: o.thread, commandId: o.command, text: o.text },
      };
    case "turns show":
      return { method: "turns.get", params: { turnId: o.turn } };
    case "turns cancel":
      return { method: "turns.cancel", params: { turnId: o.turn } };
    case "commands show":
      return { method: "commands.get", params: { commandId: o.command } };
    case "context show":
      return { method: "context.get", params: { turnId: o.turn } };
    case "memory search":
      return {
        method: "memory.search",
        params: { threadId: o.thread, input: { query: o.query } },
      };
    case "memory get":
      return {
        method: "memory.get",
        params: { threadId: o.thread, input: { ref: o.ref } },
      };
    case "interactions respond":
      return {
        method: "interactions.respond",
        params: { id: o.id, response: JSON.parse(String(o.response)) },
      };
    default:
      throw new ControllerError(
        "invalid_command",
        "Unknown controller operation",
      );
  }
}
async function runService(
  config: ServiceConfig,
  log: (event: string, data: unknown) => void,
): Promise<void> {
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
            workspaces: config.workspaces,
            shimCommand,
          })
        : new CodexProvider(config.workspaces, {
            id: provider.id,
            shimCommand,
          }),
    ]),
  );
  const store = new ControllerStore(config.database);
  const controller = new Controller(store, providers);
  let server: Awaited<ReturnType<typeof serveController>> | undefined;
  try {
    const credentials = await Promise.all(
      config.credentials.map(async (credential) => ({
        token: await readToken(credential.tokenFile),
        principal: credential.principal,
      })),
    );
    controller.start();
    server = await serveController(controller, {
      credentials,
      bind: config.bind,
      port: config.port,
    });
    log("ready", {
      url: server.url,
      providers: config.providers.map((item) => item.id),
    });
    await stopped();
  } finally {
    await server?.close();
    await controller.close();
    store.close();
    log("stopped", {});
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stopped(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
