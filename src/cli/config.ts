import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ControllerError, type Principal } from "../contracts.js";
export interface ServiceConfig {
  schema: "lapis-ai-controller.config/1";
  bind: "127.0.0.1" | "::1";
  port: number;
  database: string;
  agentConfig?: string;
  workspaces: Record<string, string>;
  providers: Array<{
    id: string;
    driver: "acp" | "codex-native";
    agent: string;
  }>;
  credentials: Array<{ tokenFile: string; principal: Principal }>;
}
export function defaultConfigPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "lapis-ai-controller",
    "config.json",
  );
}
export async function readConfig(path: string): Promise<ServiceConfig> {
  const content: unknown = JSON.parse(await readFile(path, "utf8"));
  return validateConfig(content);
}
export function validateConfig(content: unknown): ServiceConfig {
  if (!content || typeof content !== "object")
    throw new ControllerError(
      "configuration_invalid",
      "Configuration must be an object",
    );
  const config = content as ServiceConfig;
  if (
    config.schema !== "lapis-ai-controller.config/1" ||
    !["127.0.0.1", "::1"].includes(config.bind) ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    typeof config.database !== "string" ||
    !isAbsolute(config.database) ||
    (config.agentConfig !== undefined &&
      (typeof config.agentConfig !== "string" ||
        !isAbsolute(config.agentConfig))) ||
    !config.workspaces ||
    !Object.keys(config.workspaces).length ||
    Object.values(config.workspaces).some(
      (path) => typeof path !== "string" || !isAbsolute(path),
    ) ||
    !Array.isArray(config.providers) ||
    !config.providers.length ||
    !Array.isArray(config.credentials) ||
    !config.credentials.length
  )
    throw new ControllerError(
      "configuration_invalid",
      "Configuration is invalid",
    );
  const ids = new Set<string>();
  for (const provider of config.providers) {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.id) ||
      ids.has(provider.id) ||
      !["acp", "codex-native"].includes(provider.driver) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider.agent)
    )
      throw new ControllerError(
        "configuration_invalid",
        "Provider configuration is invalid",
      );
    ids.add(provider.id);
  }
  for (const credential of config.credentials) {
    const principal = credential.principal;
    if (
      !isAbsolute(credential.tokenFile) ||
      !principal ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(principal.id) ||
      !Array.isArray(principal.providers) ||
      principal.providers.some((id) => !ids.has(id)) ||
      !Array.isArray(principal.workspaces) ||
      principal.workspaces.some((id) => !Object.hasOwn(config.workspaces, id))
    )
      throw new ControllerError(
        "configuration_invalid",
        "Credential scope is invalid",
      );
  }
  return config;
}
export async function readToken(path: string): Promise<string> {
  const details = await stat(path);
  if (
    !details.isFile() ||
    (process.platform !== "win32" && (details.mode & 0o077) !== 0)
  )
    throw new ControllerError(
      "private_permissions",
      "Credential file must be owner-only",
    );
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 24)
    throw new ControllerError(
      "configuration_invalid",
      "Credential token is too short",
    );
  return token;
}
export async function initialize(
  path: string,
  workspace: string,
): Promise<ServiceConfig> {
  const absolute = resolve(path);
  const root = dirname(absolute);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tokenFile = join(root, "token");
  const config: ServiceConfig = {
    schema: "lapis-ai-controller.config/1",
    bind: "127.0.0.1",
    port: 7346,
    database: join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "lapis-ai-controller",
      "controller.sqlite",
    ),
    workspaces: { default: resolve(workspace) },
    providers: [
      { id: "codex", driver: "acp", agent: "codex" },
      { id: "cursor", driver: "acp", agent: "cursor" },
      { id: "codex-native", driver: "codex-native", agent: "codex" },
    ],
    credentials: [
      {
        tokenFile,
        principal: {
          id: "local",
          providers: ["codex", "cursor", "codex-native"],
          workspaces: ["default"],
        },
      },
    ],
  };
  try {
    await stat(absolute);
    const existing = await readConfig(absolute);
    if (existing.workspaces.default !== resolve(workspace))
      throw new ControllerError(
        "configuration_conflict",
        "Configuration exists for a different workspace",
      );
    await readToken(existing.credentials[0]!.tokenFile);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeFile(tokenFile, `${randomBytes(32).toString("base64url")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await readToken(tokenFile);
  }
  await writeFile(absolute, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return config;
}
