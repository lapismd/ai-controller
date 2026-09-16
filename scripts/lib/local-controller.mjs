import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const BINARY = "lapis-ai-controller";
export const PROTOCOL = "lapis-ai-controller/1";
export const READY_DEADLINE_MS = 20_000;

export const HELP = `Build, install, and run the local AI controller as a user service.

Usage:
  pnpm local:controller [-- --workspace <dir>] [--config <file>]
                        [--instance <name>] [--install-path <file>]

Defaults:
  --config        ~/.config/lapis-ai-controller/config.json
  --instance      default
  --install-path  ~/.local/bin/lapis-ai-controller

--workspace is required only when the configuration file does not exist.`;

export function parseOptions(args) {
  const result = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const key = new Map([
      ["--workspace", "workspace"],
      ["--config", "configFile"],
      ["--instance", "instance"],
      ["--install-path", "installPath"],
    ]).get(argument);
    if (!key) throw new Error(`Unknown local-controller option: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

export function resolveSelection({
  home,
  env = process.env,
  options = {},
} = {}) {
  if (!home) throw new Error("HOME is required for local controller development");
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const configFile = resolve(
    options.configFile ??
      env.LAPIS_AI_CONTROLLER_CONFIG ??
      join(configHome, BINARY, "config.json"),
  );
  const installPath = resolve(
    options.installPath ??
      env.LAPIS_AI_CONTROLLER_INSTALL_PATH ??
      join(home, ".local", "bin", BINARY),
  );
  const workspaceSource =
    options.workspace ?? env.LAPIS_AI_CONTROLLER_WORKSPACE;
  return {
    configFile,
    installPath,
    instance: options.instance ?? "default",
    workspace: workspaceSource ? resolve(workspaceSource) : undefined,
  };
}

export function isReadyStatus(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    return envelope.data?.protocol === PROTOCOL;
  } catch {
    return false;
  }
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function installExecutable(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function waitForReady(invoke, { deadlineMs = READY_DEADLINE_MS } = {}) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await invoke();
    if (result.code === 0 && isReadyStatus(result.stdout)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(
    `Local controller did not become ready within ${deadlineMs / 1000} seconds`,
  );
}

export function controllerArgs(command, selection) {
  return [
    ...command,
    "--config",
    selection.configFile,
    "--instance",
    selection.instance,
  ];
}

export async function runLocalController(
  {
    args,
    home = process.env.HOME || homedir(),
    env = process.env,
    root,
    artifact = join(root, "artifacts", BINARY),
  },
  io,
) {
  const options = parseOptions(args);
  if (options.help) {
    io.log(HELP);
    return 0;
  }
  const selection = resolveSelection({ home, env, options });
  const configExists = await io.exists(selection.configFile);
  if (!configExists && !selection.workspace) {
    throw new Error(
      "Missing configuration. Pass --workspace to initialize one.",
    );
  }

  if (configExists && (await io.exists(selection.installPath))) {
    await io.output(
      selection.installPath,
      controllerArgs(["service", "stop"], selection),
    );
  }

  io.log(`Building ${BINARY}...`);
  await io.run("pnpm", ["build:cli"], root);
  await io.install(artifact, selection.installPath);

  if (!configExists) {
    await io.run(
      selection.installPath,
      controllerArgs(["init", "--workspace", selection.workspace], selection),
    );
  }

  await io.run(
    selection.installPath,
    controllerArgs(["service", "install"], selection),
  );
  await io.run(
    selection.installPath,
    controllerArgs(["service", "start"], selection),
  );
  await waitForReady(() =>
    io.output(
      selection.installPath,
      controllerArgs(["status", "--json"], selection),
    ),
  );
  await io.run(
    selection.installPath,
    controllerArgs(["doctor"], selection),
  );
  io.log(`Local controller is ready via ${selection.installPath}.`);
  return 0;
}

export function spawnCommand(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise(code === 0 ? undefined : { failed: true, code: code ?? 1 });
    });
  });
}

export function spawnOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolvePromise({ code: code ?? 1, stdout });
    });
  });
}
