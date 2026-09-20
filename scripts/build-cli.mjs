import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const stage = await mkdtemp(join(tmpdir(), "lapis-ai-controller-build-"));
function run(command, args, cwd = stage) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
}
try {
  await cp("dist/main.js", join(stage, "main.js"));
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const dependencies = {
    "@types/node": JSON.parse(
      await readFile(require.resolve("@types/node/package.json"), "utf8"),
    ).version,
  };
  for (const name of Object.keys(manifest.dependencies)) {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)));
    while (true) {
      try {
        const installed = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (installed.name === name) {
          // Pack the installed runtime package, including verified local builds.
          // This staging tree never includes this repository's previous binaries.
          const archiveDir = join(stage, "packages", name.replaceAll("/", "-"));
          await mkdir(archiveDir, { recursive: true });
          run(
            "npm",
            ["pack", "--quiet", "--ignore-scripts", "--pack-destination", archiveDir],
            directory,
          );
          const { readdir } = await import("node:fs/promises");
          const archive = (await readdir(archiveDir)).find((file) =>
            file.endsWith(".tgz"),
          );
          dependencies[name] = `file:${join(archiveDir, archive)}`;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(`Could not resolve installed ${name}`);
      directory = parent;
    }
  }
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  run("pnpm", ["install", "--prod", "--ignore-scripts", "--lockfile=false"]);
  run("deno", [
    "compile",
    "--no-config",
    "--node-modules-dir=manual",
    "--self-extracting",
    "-A",
    "--exclude",
    "packages",
    "--include",
    "node_modules/@lapismd/agent-redaction/dist/sync-worker.js",
    "--include",
    "node_modules/@lapismd/agent-redaction/dist/node-worker.js",
    "--output",
    "controller",
    "main.js",
  ]);
  await mkdir("artifacts", { recursive: true });
  await cp(join(stage, "controller"), resolve("artifacts/lapis-ai-controller"));
} finally {
  await rm(stage, { recursive: true, force: true });
}
