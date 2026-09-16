import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { currentSelfInvocation, type SelfInvocation } from "./self.js";
import { BINARY } from "./brand.js";
import { CliError } from "./types.js";
import { createHash } from "node:crypto";

export type ServicePlatform = "launchd" | "systemd";

export interface ServiceDefinition {
  platform: ServicePlatform;
  id: string;
  path: string;
  logPath: string | null;
  contents: string;
}

export interface ServiceState {
  platform: ServicePlatform;
  id: string;
  installed: boolean;
  loaded: boolean;
  state: "running" | "starting" | "stopped";
  definitionPath: string;
  logPath: string | null;
}

type CommandResult = { code: number; stdout: string; stderr: string };
type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

export function serviceDefinition(
  configPath: string,
  instance = "default",
  options: {
    platform?: ServicePlatform;
    home?: string;
    stateDirectory?: string;
    invocation?: SelfInvocation;
    pathEnvironment?: string;
  } = {},
): ServiceDefinition {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(instance))
    throw new Error("Service instance is invalid");
  const platform =
    options.platform ?? (process.platform === "darwin" ? "launchd" : "systemd");
  const home = options.home ?? homedir();
  const invocation = options.invocation ?? currentSelfInvocation();
  const absoluteConfig = resolve(configPath);
  const stateDirectory =
    options.stateDirectory ??
    process.env.XDG_STATE_HOME?.trim() ??
    join(home, ".local", "state");
  const configId = createHash("sha256")
    .update(absoluteConfig)
    .digest("hex")
    .slice(0, 10);
  const command = [
    invocation.command,
    ...invocation.argsPrefix,
    "serve",
    "--json",
    "--config",
    absoluteConfig,
    "--instance",
    instance,
  ];
  const environment: Record<string, string> = {
    PATH: options.pathEnvironment ?? process.env.PATH ?? "/usr/bin:/bin",
    XDG_STATE_HOME: resolve(stateDirectory),
    TMPDIR: tmpdir(),
    ...(process.env.XDG_RUNTIME_DIR
      ? { XDG_RUNTIME_DIR: resolve(process.env.XDG_RUNTIME_DIR) }
      : {}),
  };
  if (platform === "launchd") {
    const id = `md.lapis.${BINARY}.${instance}.${configId}`;
    const logPath = join(stateDirectory, BINARY, `${instance}-${configId}.log`);
    return {
      platform,
      id,
      path: join(home, "Library", "LaunchAgents", `${id}.plist`),
      logPath,
      contents: launchdPlist(id, command, logPath, environment),
    };
  }
  const id = `${BINARY}-${instance}-${configId}.service`;
  return {
    platform,
    id,
    path: join(home, ".config", "systemd", "user", id),
    logPath: null,
    contents: systemdUnit(command, environment),
  };
}

export async function installService(
  definition: ServiceDefinition,
  run: CommandRunner = runCommand,
): Promise<ServiceState> {
  const previous = await readFile(definition.path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (previous === definition.contents) return startService(definition, run);
  await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
  if (definition.logPath)
    await mkdir(dirname(definition.logPath), { recursive: true, mode: 0o700 });
  await atomicWrite(definition.path, definition.contents, 0o600);
  if (definition.platform === "launchd") {
    const target = launchdTarget(definition.id);
    const loaded = (await run("launchctl", ["print", target])).code === 0;
    if (loaded)
      requireSuccess(
        await run("launchctl", ["bootout", launchdDomain(), definition.path]),
        "Could not reload launchd service",
      );
    requireSuccess(
      await run("launchctl", ["bootstrap", launchdDomain(), definition.path]),
      "Could not register launchd service",
    );
  } else {
    requireSuccess(
      await run("systemctl", ["--user", "daemon-reload"]),
      "Could not reload systemd",
    );
    requireSuccess(
      await run("systemctl", ["--user", "enable", definition.id]),
      "Could not enable systemd service",
    );
  }
  return startService(definition, run);
}

export async function startService(
  definition: ServiceDefinition,
  run: CommandRunner = runCommand,
): Promise<ServiceState> {
  if (definition.platform === "launchd") {
    const loaded =
      (await run("launchctl", ["print", launchdTarget(definition.id)])).code ===
      0;
    if (!loaded)
      requireSuccess(
        await run("launchctl", ["bootstrap", launchdDomain(), definition.path]),
        "Could not start launchd service",
      );
  } else {
    requireSuccess(
      await run("systemctl", ["--user", "start", definition.id]),
      "Could not start systemd service",
    );
  }
  return serviceStatus(definition, run);
}

export async function stopService(
  definition: ServiceDefinition,
  run: CommandRunner = runCommand,
): Promise<ServiceState> {
  if (definition.platform === "launchd") {
    const loaded =
      (await run("launchctl", ["print", launchdTarget(definition.id)])).code ===
      0;
    if (!loaded) return serviceStatus(definition, run);
    const result = await run("launchctl", [
      "bootout",
      launchdDomain(),
      definition.path,
    ]);
    if (
      result.code !== 0 &&
      !/could not find|no such process/iu.test(result.stderr)
    )
      requireSuccess(result, "Could not stop launchd service");
  } else {
    const result = await run("systemctl", ["--user", "stop", definition.id]);
    if (result.code !== 0 && !/not loaded|not found/iu.test(result.stderr))
      requireSuccess(result, "Could not stop systemd service");
  }
  return serviceStatus(definition, run);
}

export async function restartService(
  definition: ServiceDefinition,
  run: CommandRunner = runCommand,
): Promise<ServiceState> {
  if (definition.platform === "launchd") {
    await stopService(definition, run);
    await startService(definition, run);
  } else {
    requireSuccess(
      await run("systemctl", ["--user", "restart", definition.id]),
      "Could not restart systemd service",
    );
  }
  return serviceStatus(definition, run);
}

export async function uninstallService(
  definition: ServiceDefinition,
  run: CommandRunner = runCommand,
): Promise<ServiceState> {
  await stopService(definition, run);
  await unlink(definition.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (definition.platform === "systemd") {
    await run("systemctl", ["--user", "disable", definition.id]);
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  return serviceStatus(definition, run);
}

export async function serviceStatus(
  definition: ServiceDefinition,
  run: CommandRunner = runCommand,
): Promise<ServiceState> {
  let installed = true;
  try {
    await readFile(definition.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") installed = false;
    else throw error;
  }
  if (definition.platform === "launchd") {
    const printed = await run("launchctl", [
      "print",
      launchdTarget(definition.id),
    ]);
    const loaded = printed.code === 0;
    return {
      platform: definition.platform,
      id: definition.id,
      installed,
      loaded,
      state: loaded
        ? /state = running/.test(printed.stdout)
          ? "running"
          : "starting"
        : "stopped",
      definitionPath: definition.path,
      logPath: definition.logPath,
    };
  }
  const active = await run("systemctl", ["--user", "is-active", definition.id]);
  const enabled = await run("systemctl", [
    "--user",
    "is-enabled",
    definition.id,
  ]);
  return {
    platform: definition.platform,
    id: definition.id,
    installed,
    loaded: enabled.code === 0,
    state: active.stdout.trim() === "active" ? "running" : "stopped",
    definitionPath: definition.path,
    logPath: null,
  };
}

function launchdPlist(
  id: string,
  command: string[],
  logPath: string,
  variables: Record<string, string>,
): string {
  const argumentsXml = command
    .map((argument) => `    <string>${xml(argument)}</string>`)
    .join("\n");
  const environment = `\n  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(
    variables,
  )
    .map(
      ([name, value]) =>
        `    <key>${xml(name)}</key>\n    <string>${xml(value)}</string>`,
    )
    .join("\n")}\n  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(id)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>${environment}
  <key>Umask</key>
  <integer>63</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdUnit(
  command: string[],
  environment: Record<string, string>,
): string {
  return `[Unit]
Description=${BINARY} host
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
UMask=0077
${Object.entries(environment)
  .map(
    ([name, value]) =>
      `Environment=${systemdQuote(`${name}=${value}`).replaceAll("$$", "$")}`,
  )
  .join("\n")}
ExecStart=${command.map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("$", "$$").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `gui/${uid}`;
}

function launchdTarget(id: string): string {
  return `${launchdDomain()}/${id}`;
}

async function atomicWrite(path: string, content: string, mode: number) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode, flag: "wx" });
  try {
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return new Promise((resolveExit, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT"
          ? new CliError(
              "unavailable",
              "The user-service manager is unavailable",
              3,
            )
          : error,
      ),
    );
    child.once("close", (code) => {
      if (
        code !== 0 &&
        /failed to connect to (?:user scope )?bus|not been booted with systemd|no medium found/iu.test(
          stderr,
        )
      )
        reject(
          new CliError(
            "unavailable",
            "The user-service manager is unavailable",
            3,
          ),
        );
      else resolveExit({ code: code ?? 1, stdout, stderr });
    });
  });
}

function requireSuccess(result: CommandResult, fallback: string): void {
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || fallback);
}
