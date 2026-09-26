import { describe, expect, it } from "vitest";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  HELP,
  PROTOCOL,
  controllerArgs,
  installExecutable,
  isReadyStatus,
  parseOptions,
  resolveSelection,
  runLocalController,
  waitForReady,
} from "./lib/local-controller.mjs";

describe("local controller installer", () => {
  it("parses overrides and rejects unknown options", () => {
    expect(parseOptions(["--help"]).help).toBe(true);
    expect(
      parseOptions([
        "--",
        "--workspace",
        "/tmp/notes",
        "--config",
        "/tmp/config.json",
        "--instance",
        "dev",
        "--install-path",
        "/tmp/bin/lapis-ai-controller",
      ]),
    ).toEqual({
      help: false,
      workspace: "/tmp/notes",
      configFile: "/tmp/config.json",
      instance: "dev",
      installPath: "/tmp/bin/lapis-ai-controller",
    });
    expect(() => parseOptions(["--bootstrap", "secret"])).toThrow(
      "Unknown local-controller option",
    );
    expect(HELP).toContain("pnpm local:controller");
    expect(HELP).not.toContain("token");
  });

  it("defaults to owner-local install and config paths", () => {
    expect(
      resolveSelection({
        home: "/Users/steve",
        env: {},
        options: {},
      }),
    ).toEqual({
      configFile: "/Users/steve/.config/lapis-ai-controller/config.json",
      installPath: "/Users/steve/.local/bin/lapis-ai-controller",
      instance: "default",
      workspace: "/Users/steve/.lapis/ai-controller",
    });
    expect(
      resolveSelection({
        home: "/Users/steve",
        env: {
          XDG_CONFIG_HOME: "/Users/steve/xdg-config",
          LAPIS_AI_CONTROLLER_CONFIG: "/tmp/alt.json",
          LAPIS_AI_CONTROLLER_INSTALL_PATH: "/tmp/bin/controller",
          LAPIS_AI_CONTROLLER_WORKSPACE: "/tmp/vault",
        },
        options: { instance: "dev" },
      }),
    ).toEqual({
      configFile: "/tmp/alt.json",
      installPath: "/tmp/bin/controller",
      instance: "dev",
      workspace: "/tmp/vault",
    });
  });

  it("installs the executable atomically and recognizes ready status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-controller-"));
    const source = join(dir, "source");
    const target = join(dir, "bin", "lapis-ai-controller");
    try {
      await writeFile(source, "#!/bin/sh\n");
      await chmod(source, 0o644);
      await installExecutable(source, target);
      expect((await stat(target)).mode & 0o777).toBe(0o755);
      expect(await readFile(target, "utf8")).toBe("#!/bin/sh\n");
      expect(isReadyStatus(`{"data":{"protocol":"${PROTOCOL}"}}`)).toBe(true);
      expect(isReadyStatus('{"data":{"protocol":"lapis-ai-host/1"}}')).toBe(
        false,
      );
      await expect(
        waitForReady(async () => ({ code: 1, stdout: "" }), {
          deadlineMs: 0,
        }),
      ).rejects.toThrow("did not become ready");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds, installs, initializes missing config, and waits without printing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-controller-run-"));
    const root = join(dir, "repo");
    const home = join(dir, "home");
    const artifact = join(root, "artifacts", "runtime");
    const commands = [];
    const logs = [];
    try {
      await mkdir(join(root, "artifacts"), { recursive: true });
      await writeFile(artifact, "binary");
      const code = await runLocalController(
        {
          args: ["--workspace", join(dir, "vault")],
          home,
          env: {},
          root,
        },
        {
          log: (text) => logs.push(text),
          exists: async (path) => path === artifact,
          install: async (source, target) => {
            commands.push(["install", source, target]);
            await mkdir(join(target, ".."), { recursive: true });
            await writeFile(target, await readFile(source));
          },
          async run(command, args, cwd) {
            commands.push(["run", command, ...args, cwd ?? ""]);
          },
          async output(command, args) {
            commands.push(["output", command, ...args]);
            if (args[0] === "status") {
              return {
                code: 0,
                stdout: JSON.stringify({
                  schema: "lapis-ai-controller.cli/1",
                  data: { protocol: PROTOCOL, token: "should-not-log" },
                }),
              };
            }
            return { code: 1, stdout: "" };
          },
        },
      );
      expect(code).toBe(0);
      expect(commands[0]).toEqual(["run", "pnpm", "build:cli", root]);
      expect(
        commands.some((entry) => entry[1] === "init" || entry.includes("init")),
      ).toBe(true);
      expect(
        commands.find((entry) => entry[0] === "run" && entry[2] === "service"),
      ).toEqual([
        "run",
        join(home, ".local", "bin", "lapis-ai-controller"),
        "service",
        "install",
        "--config",
        join(home, ".config", "lapis-ai-controller", "config.json"),
        "--instance",
        "default",
        "",
      ]);
      expect(logs.join("\n")).toContain("ready via");
      expect(logs.join("\n")).not.toContain("should-not-log");
      expect(
        controllerArgs(["status", "--json"], {
          configFile: "/tmp/config.json",
          instance: "default",
        }),
      ).toEqual([
        "status",
        "--json",
        "--config",
        "/tmp/config.json",
        "--instance",
        "default",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing config and stops the previous binary before replace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-controller-reuse-"));
    const commands = [];
    const configFile = join(dir, "config.json");
    const installPath = join(dir, "bin", "lapis-ai-controller");
    try {
      await mkdir(join(dir, "bin"), { recursive: true });
      await writeFile(configFile, "{}");
      await writeFile(installPath, "old");
      await runLocalController(
        {
          args: ["--config", configFile, "--install-path", installPath],
          home: dir,
          env: {},
          root: dir,
          artifact: join(dir, "artifact"),
        },
        {
          log: () => {},
          exists: async () => true,
          install: async () => {},
          async run(command, args) {
            commands.push(["run", command, ...args]);
          },
          async output(command, args) {
            commands.push(["output", command, ...args]);
            return {
              code: 0,
              stdout: JSON.stringify({ data: { protocol: PROTOCOL } }),
            };
          },
        },
      );
      expect(commands[0]).toEqual([
        "output",
        installPath,
        "service",
        "stop",
        "--config",
        configFile,
        "--instance",
        "default",
      ]);
      expect(commands.some((entry) => entry.includes("init"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults first-run workspace to ~/.lapis/ai-controller", async () => {
    const commands = [];
    const home = "/tmp/home";
    const root = "/tmp/repo";
    const artifact = join(root, "artifacts", "runtime");
    await runLocalController(
      { args: [], home, env: {}, root, artifact },
      {
        log: () => {},
        exists: async () => false,
        install: async () => {},
        async run(command, args) {
          commands.push(["run", command, ...args]);
        },
        async output() {
          return {
            code: 0,
            stdout: JSON.stringify({ data: { protocol: PROTOCOL } }),
          };
        },
      },
    );
    expect(
      commands.find((entry) => entry[0] === "run" && entry[2] === "init"),
    ).toEqual([
      "run",
      join(home, ".local", "bin", "lapis-ai-controller"),
      "init",
      "--workspace",
      join(home, ".lapis", "ai-controller"),
      "--config",
      join(home, ".config", "lapis-ai-controller", "config.json"),
      "--instance",
      "default",
    ]);
  });
});
