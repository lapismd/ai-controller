import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

// Only prepares source versions and the lockfile. Publication is deliberately
// absent; the existing operator-owned publication workflow remains authority.
execFileSync("pnpm", ["exec", "changeset", "version"], { stdio: "inherit" });
const pkg = JSON.parse(await readFile("package.json", "utf8"));
try {
  const file = "manifest.json";
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.version = pkg.version;
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const runtime = {
  "@lapis-notes/lapis-plugin-notebook": "src/lib/notebook-plugin.ts",
  "@lapis-notes/lapis-plugin-docs": "src/lib/docs-plugin.ts",
}[pkg.name];
if (runtime) {
  const text = await readFile(runtime, "utf8");
  const updated = text.replace(
    /(const MANIFEST: PluginManifest = \{[\s\S]*?version:\s*)"[^"]+"/,
    `$1${JSON.stringify(pkg.version)}`,
  );
  if (
    updated === text &&
    !text.includes(`version: ${JSON.stringify(pkg.version)}`)
  )
    throw Error("Cannot locate the plugin runtime manifest version");
  await writeFile(runtime, updated);
}
execFileSync(
  "pnpm",
  ["install", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile"],
  { stdio: "inherit" },
);
