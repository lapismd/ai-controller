import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageDirectory } from "./runtime-packages.mjs";

/** Preserve notices for bundled and materialized npm dependencies. */
export async function writeNotices(root, output, names, overrides = {}) {
  const seen = new Set();
  const notices = [
    "This application uses an externally installed Deno runtime.",
  ];
  async function visit(name, from) {
    let directory;
    try {
      directory = await realpath(
        overrides[name] ?? (await packageDirectory(name, from)),
      );
    } catch {
      return;
    }
    if (seen.has(directory)) return;
    seen.add(directory);
    const pkg = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    notices.push(
      `\n===== ${pkg.name}@${pkg.version} (${pkg.license ?? "see package license"}) =====`,
    );
    for (const file of (await readdir(directory)).sort()) {
      if (/^(license|licence|notice|copying)([.-].*)?$/i.test(file)) {
        try {
          notices.push(await readFile(join(directory, file), "utf8"));
        } catch (error) {
          if (error.code !== "EISDIR") throw error;
        }
      }
    }
    for (const dependency of Object.keys(pkg.dependencies ?? {}).sort())
      await visit(dependency, directory);
  }
  for (const name of names) await visit(name, root);
  await writeFile(join(output, "NOTICES.txt"), notices.join("\n") + "\n");
}
