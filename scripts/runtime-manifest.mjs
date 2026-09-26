import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function inventory(root) {
  const files = {};
  const canonical = await realpath(root);
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const key = relative(root, path).split(sep).join("/");
      if (key === "runtime-manifest.json") continue;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path);
        if (target.startsWith("/") || !resolved.startsWith(canonical + sep))
          throw new Error(`Runtime link escapes snapshot: ${key}`);
        files[key] = { link: target };
      } else if (info.isDirectory()) await visit(path);
      else if (info.isFile())
        files[key] = {
          sha256: hash(await readFile(path)),
          executable: !!(info.mode & 0o111),
          bytes: info.size,
        };
      else throw new Error(`Unsupported runtime file: ${key}`);
    }
  }
  await visit(resolve(root));
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export async function writeManifest(root, build) {
  const files = await inventory(root);
  const payload = {
    schema: "lapis.cli-runtime/1",
    ...build,
    entry: "cli.js",
    files,
  };
  const manifest = { ...payload, digest: hash(JSON.stringify(payload)) };
  await writeFile(
    join(root, "runtime-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
export async function verifyRuntime(root) {
  const manifest = JSON.parse(
    await readFile(join(root, "runtime-manifest.json"), "utf8"),
  );
  const { digest, ...payload } = manifest;
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(manifest.command) ||
    manifest.schema !== "lapis.cli-runtime/1" ||
    manifest.entry !== "cli.js" ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    hash(JSON.stringify(payload)) !== digest
  )
    throw new Error("Invalid runtime manifest");
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(manifest.files))
    throw new Error("Runtime snapshot checksum mismatch");
  return manifest;
}
