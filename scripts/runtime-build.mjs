import { writeNotices } from "./runtime-notices.mjs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeManifest } from "./runtime-manifest.mjs";
import { resolveDeno } from "./runtime-install.mjs";
import { localOverrides, materializePackages } from "./runtime-packages.mjs";

export function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${result.error?.message ?? ""}`,
    );
}
export function revision(root) {
  const diff = spawnSync("jj", ["--no-pager", "diff", "--summary"], {
    cwd: root,
    encoding: "utf8",
  });
  const result = spawnSync(
    "jj",
    [
      "--no-pager",
      "log",
      "--no-graph",
      "-r",
      diff.stdout?.trim() ? "@" : "@-",
      "-T",
      "commit_id",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return result.status === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout.trim())
    ? result.stdout.trim()
    : "unknown";
}
export async function buildRuntime(root, command, options = {}) {
  const deno = resolveDeno();
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const build = {
    version: pkg.version,
    revision: revision(root),
    builtAt: new Date().toISOString(),
  };
  const artifacts = join(root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const stage = await mkdtemp(join(artifacts, ".runtime-"));
  try {
    const config = options.config ?? "deno.json";
    const input = options.input ?? "src/main.ts";
    run(
      deno,
      [
        "bundle",
        "--no-lock",
        "--config",
        config,
        "--sloppy-imports",
        "--packages",
        "external",
        "--external",
        "@lapismd/*",
        "--output",
        join(stage, "cli.js"),
        input,
      ],
      root,
    );
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({ type: "module", private: true }),
    );
    await writeFile(join(stage, "build-metadata.json"), JSON.stringify(build));
    // The bootstrap is identical for local and JSR entry points; only payload configuration differs.
    await rename(join(stage, "cli.js"), join(stage, "main.js"));
    await writeFile(
      join(stage, "cli.js"),
      `import build from "./build-metadata.json" with { type: "json" };\nconst [major,minor,patch] = Deno.version.deno.split(".").map(Number);\nif (major < 2 || major === 2 && (minor < 9 || minor === 9 && patch < 5)) throw new Error("Deno 2.9.5 or newer is required");\nglobalThis.__LAPIS_CLI_BUILD__ = build;\nif (import.meta.url.startsWith("file:")) {\n  const manifest = new URL("./runtime-manifest.json", import.meta.url);\n  if (await Deno.stat(manifest).then(s => s.isFile, () => false)) Deno.env.set("LAPIS_CLI_RELEASE", decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/\\/$/, ""));\n  else Deno.env.delete("LAPIS_CLI_RELEASE");\n} else Deno.env.delete("LAPIS_CLI_RELEASE");\nawait import("./main.js");\n`,
    );
    if (options.prepare) await options.prepare(stage, deno, build);
    const names = options.packages ?? [];
    const overrides = await localOverrides(root);
    await materializePackages(root, stage, names, overrides);
    await cp(join(root, "LICENSE.md"), join(stage, "LICENSE.md")).catch(
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    await writeNotices(
      root,
      stage,
      [...new Set([...names, ...Object.keys(pkg.dependencies ?? {})])],
      overrides,
    );
    const manifest = await writeManifest(stage, {
      command,
      build,
      minimumDeno: "2.9.5",
      smoke: options.smoke ?? [],
    });
    const jsr = join(artifacts, "jsr");
    await rm(jsr, { recursive: true, force: true });
    await cp(stage, jsr, {
      recursive: true,
      filter: (path) =>
        !path.startsWith(join(stage, "node_modules")) &&
        !path.endsWith("runtime-manifest.json") &&
        !path.includes("/native/"),
    });
    const imports = {};
    for (const name of names) {
      const version = pkg.dependencies?.[name] ?? "^0.1.0";
      imports[name] = `npm:${name}@${version}`;
      imports[`${name}/`] = `npm:${name}@${version}/`;
    }
    await rm(join(jsr, "package.json"));
    await writeFile(join(jsr, "cli.d.ts"), "export {};\n");
    await writeFile(
      join(jsr, "cli.js"),
      '// @ts-self-types="./cli.d.ts"\n' +
        (await readFile(join(jsr, "cli.js"), "utf8")),
    );
    await writeFile(
      join(jsr, "deno.json"),
      JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          exports: { "./cli": "./cli.js" },
          imports,
          publish: {
            include: ["*.js", "*.ts", "*.json", "LICENSE.md", "NOTICES.txt"],
          },
        },
        null,
        2,
      ),
    );
    await cp(join(root, "LICENSE.md"), join(jsr, "LICENSE.md")).catch(
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const output = join(artifacts, "runtime");
    await rm(output, { recursive: true, force: true });
    await rename(stage, output);
    console.log(
      `${command}: ${Object.values(manifest.files).reduce((total, f) => total + (f.bytes ?? 0), 0)} bytes; Deno runtime excluded`,
    );
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
