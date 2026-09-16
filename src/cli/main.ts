import { readFile } from "node:fs/promises";
import { ControllerClient } from "../client.js";
import { ControllerError } from "../contracts.js";
import { cliFailure } from "./types.js";
import { startService } from "../service.js";
import {
  defaultConfigPath,
  defaultWorkspacePath,
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
      const config = await initialize(
        path,
        String(o.workspace || defaultWorkspacePath()),
      );
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
    const failure = cliFailure(error);
    if (json)
      io.stdout(
        JSON.stringify({
          schema: "lapis-ai-controller.cli/1",
          ok: false,
          error: { code: failure.code, message: failure.message },
        }),
      );
    else io.stderr(`Error [${failure.code}]: ${failure.message}`);
    return failure.exitCode;
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
    case "providers models":
      return {
        method: "providers.models",
        params: { provider: o.provider, workspace: o.workspace },
      };
    case "threads configure":
      return {
        method: "threads.configure",
        params: {
          threadId: o.thread,
          version: Number(o["expected-version"]),
          configuration: JSON.parse(String(o.configuration)),
        },
      };
    case "events read":
      return {
        method: "events.read",
        params: {
          threadId: o.thread,
          after: o.after,
          ...(o.limit ? { limit: Number(o.limit) } : {}),
        },
      };
    case "interactions list":
      return { method: "interactions.list", params: { threadId: o.thread } };
    case "tools list":
      return { method: "tools.list", params: { threadId: o.thread } };
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
    case "turns resolve":
      return {
        method: "turns.resolve",
        params: {
          turnId: o.turn,
          outcome: o.outcome,
          externalStopped: o.stopped === true,
        },
      };
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
  const credentials = await Promise.all(
    config.credentials.map(async (credential) => ({
      token: await readToken(credential.tokenFile),
      principal: credential.principal,
    })),
  );
  const running = await startService(config, credentials);
  try {
    log("ready", {
      url: running.url,
      providers: config.providers.map((item) => item.id),
    });
    await stopped();
  } finally {
    await running.close();
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
