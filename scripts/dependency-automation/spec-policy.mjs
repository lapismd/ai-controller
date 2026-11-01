import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function botSpecificationExemption(env = process.env) {
  if (env.CI !== "true") return false;
  let name = env.LAPIS_CI_EVENT ?? env.GITHUB_EVENT_NAME;
  let author = env.LAPIS_CI_PR_AUTHOR,
    type = env.LAPIS_CI_PR_AUTHOR_TYPE,
    head = env.LAPIS_CI_PR_HEAD;
  if (env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
      author = event.pull_request?.user?.login;
      type = event.pull_request?.user?.type;
      head = event.pull_request?.head?.ref;
      name = env.GITHUB_EVENT_NAME;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (name !== "pull_request" || type !== "Bot") return false;
  const trusted = new Set([
    "dependabot[bot]",
    "renovate[bot]",
    "lapismd-dependency-bot[bot]",
  ]);
  if (env.LAPIS_DEPENDENCY_BOT_LOGIN)
    trusted.add(env.LAPIS_DEPENDENCY_BOT_LOGIN);
  return (
    trusted.has(author) ||
    (author === "github-actions[bot]" && head === "changeset-release/main")
  );
}

export function skipSpecification(lane, env = process.env) {
  const spec =
    /^(?:spec:(?:check|validate|first|build|lint)|check:specification-docs)$/.test(
      lane,
    );
  if (!spec || !botSpecificationExemption(env)) return false;
  console.log(
    `Specification check ${lane} skipped for the trusted dependency-bot PR; functional checks remain enabled.`,
  );
  return true;
}

export function specificationDockerArguments(args, env = process.env) {
  if (args[0] !== "create" || !args.includes("/input/worker.mjs")) return args;
  const names = [
    "CI",
    "LAPIS_CI_EVENT",
    "LAPIS_CI_PR_AUTHOR",
    "LAPIS_CI_PR_AUTHOR_TYPE",
    "LAPIS_CI_PR_HEAD",
    "LAPIS_DEPENDENCY_BOT_LOGIN",
  ];
  const context = names
    .filter((name) => env[name] !== undefined)
    .flatMap((name) => ["--env", `${name}=${env[name]}`]);
  return [args[0], ...context, ...args.slice(1)];
}

export async function runFunctionalCheckLanes({
  local = false,
  root = process.cwd(),
  loadConfig,
  run = spawnSync,
} = {}) {
  const config = loadConfig
    ? await loadConfig(root)
    : await (
        await import(
          local
            ? pathToFileURL(resolve(root, "dist/index.js")).href
            : "@lapismd/spec-validator"
        )
      ).loadResolvedConfig(root);
  for (const lane of config.check?.lanes ?? []) {
    const result = run(lane.command, lane.args ?? [], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args[0] === "--command") {
    const [, lane, command, ...rest] = args;
    if (!skipSpecification(lane)) {
      const result = spawnSync(
        "/bin/sh",
        ["-c", command + ' "$@"', "specification", ...rest],
        { stdio: "inherit", env: process.env },
      );
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    }
  } else {
    const local = args[0] === "--local";
    if (local) args.shift();
    const operation = args.shift();
    if (!/^(check|validate|first|build|lint)$/.test(operation ?? ""))
      throw Error("Expected a specification check operation");
    if (!skipSpecification(`spec:${operation}`)) {
      const command = local ? process.execPath : "pnpm";
      const childArgs = local
        ? ["dist/cli.js", operation, ...args]
        : ["exec", "spec-validator", operation, ...args];
      const result = spawnSync(command, childArgs, {
        stdio: "inherit",
        env: process.env,
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else if (operation === "check") {
      // The validator's aggregate command may contain package tests and audits.
      // Skip its specification phases while retaining every configured lane.
      process.exitCode = await runFunctionalCheckLanes({ local });
    }
  }
}
