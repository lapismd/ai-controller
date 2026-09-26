import {
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { verifyRuntime } from "./runtime-manifest.mjs";

export function supportedDeno(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    major > 2 || (major === 2 && (minor > 9 || (minor === 9 && patch >= 5)))
  );
}
export function resolveDeno(command = globalThis.Deno?.execPath() ?? "deno") {
  const probe = spawnSync(
    command,
    [
      "eval",
      "--no-config",
      "--no-lock",
      "console.log(JSON.stringify({version:Deno.version.deno,path:Deno.execPath()}))",
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0)
    throw new Error("Deno 2.9.5 or newer is required; install Deno and retry");
  const value = JSON.parse(probe.stdout);
  if (!supportedDeno(value.version))
    throw new Error(`Deno 2.9.5 or newer is required (found ${value.version})`);
  return value.path;
}
export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function launcherScript(deno, release, destination, environment = {}) {
  const variables = {
    ...environment,
    LAPIS_CLI_RELEASE: release,
    LAPIS_CLI_LAUNCHER: destination,
  };
  return `#!/bin/sh\nif [ ! -x ${shellQuote(deno)} ]; then echo 'Deno is unavailable; reinstall Deno and run install:cli again' >&2; exit 127; fi\n${Object.entries(
    variables,
  )
    .map(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key))
        throw new Error("Invalid launcher environment name");
      return `export ${key}=${shellQuote(value)}`;
    })
    .join(
      "\n",
    )}\nexec ${shellQuote(deno)} run --no-config --no-lock --node-modules-dir=manual --no-prompt -A ${shellQuote(join(release, "cli.js"))} "$@"\n`;
}
export async function installRuntime(source, options = {}) {
  const manifest = await verifyRuntime(source);
  const deno = resolveDeno(options.deno);
  const home = options.home ?? homedir();
  const destination = resolve(
    options.installPath ?? join(home, ".local/bin", manifest.command),
  );
  const releases = join(home, ".local/lib", manifest.command, "releases");
  const release = join(releases, manifest.digest);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const stage = join(releases, `.install-${randomUUID()}`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await cp(source, stage, { recursive: true, verbatimSymlinks: true });
    await verifyRuntime(stage);
    const smoke = spawnSync(
      deno,
      [
        "run",
        "--no-config",
        "--no-lock",
        "--node-modules-dir=manual",
        "--no-prompt",
        "-A",
        join(stage, manifest.entry),
        "--version",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        cwd: stage,
        env: { ...process.env, LAPIS_CLI_RELEASE: stage },
      },
    );
    if (smoke.status !== 0)
      throw new Error(
        `Runtime smoke failed: ${smoke.stderr || smoke.error?.message || smoke.status}`,
      );
    for (const args of manifest.smoke ?? []) {
      const result = spawnSync(
        deno,
        [
          "run",
          "--no-config",
          "--no-lock",
          "--node-modules-dir=manual",
          "--no-prompt",
          "-A",
          join(stage, manifest.entry),
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          cwd: stage,
          env: { ...process.env, LAPIS_CLI_RELEASE: stage },
        },
      );
      if (result.status !== 0)
        throw new Error(
          `Runtime worker smoke failed: ${result.stderr || result.error?.message || result.status}`,
        );
    }
    if (options.smoke) await options.smoke(stage, deno);
    await verifyRuntime(stage);
    try {
      await stat(release);
      await verifyRuntime(release);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await rename(stage, release);
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      launcherScript(deno, release, destination, options.environment),
      { mode: 0o755, flag: "wx" },
    );
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
    return {
      path: destination,
      release,
      digest: manifest.digest,
      deno,
      build: manifest.build,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
}
export function installOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    const name = {
      "--install-path": "installPath",
      "--home": "home",
      "--deno": "deno",
      "--artifact": "artifact",
    }[args[i]];
    if (!name || !args[i + 1] || args[i + 1].startsWith("--"))
      throw new Error(`Invalid install option: ${args[i]}`);
    options[name] = resolve(args[++i]);
  }
  return options;
}
