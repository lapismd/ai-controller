import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export async function packageDirectory(name, from) {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    try {
      return await realpath(join(directory, "node_modules", name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory)
      throw new Error(`Missing installed runtime dependency ${name}`);
  }
}
export async function materializePackages(root, output, names, overrides = {}) {
  const copied = new Map();
  async function install(name, from, linkRoot) {
    const source = await realpath(
      overrides[name] ?? (await packageDirectory(name, from)),
    );
    let target = copied.get(source);
    if (!target) {
      const manifest = JSON.parse(
        await readFile(join(source, "package.json"), "utf8"),
      );
      target = join(
        output,
        "node_modules",
        ".runtime",
        `${copied.size}-${manifest.name.replaceAll("/", "-")}`,
      );
      copied.set(source, target);
      const archive = await mkdtemp(join(tmpdir(), "lapis-runtime-package-"));
      try {
        const packed = spawnSync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", archive],
          { cwd: source, encoding: "utf8" },
        );
        if (packed.status !== 0)
          throw new Error(`Could not pack ${name}: ${packed.stderr}`);
        const file = JSON.parse(packed.stdout)[0].filename;
        await mkdir(target, { recursive: true });
        const unpacked = spawnSync(
          "tar",
          ["-xzf", join(archive, file), "--strip-components=1", "-C", target],
          { encoding: "utf8" },
        );
        if (unpacked.status !== 0)
          throw new Error(`Could not unpack ${name}: ${unpacked.stderr}`);
        await prune(target);
      } finally {
        await rm(archive, { recursive: true, force: true });
      }
      for (const dependency of Object.keys(manifest.dependencies ?? {}).sort())
        await install(dependency, source, join(target, "node_modules"));
      for (const dependency of Object.keys(
        manifest.optionalDependencies ?? {},
      ).sort()) {
        try {
          await packageDirectory(dependency, source);
        } catch {
          continue;
        }
        await install(dependency, source, join(target, "node_modules"));
      }
      for (const dependency of Object.keys(
        manifest.peerDependencies ?? {},
      ).sort()) {
        try {
          await packageDirectory(dependency, source);
        } catch {
          continue;
        }
        if (!(dependency in (manifest.dependencies ?? {})))
          await install(dependency, source, join(target, "node_modules"));
      }
    }
    const link = join(linkRoot, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), target), link).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  for (const name of names)
    await install(name, root, join(output, "node_modules"));
  return copied.size;
}
export async function localOverrides(root) {
  let config;
  try {
    config = JSON.parse(await readFile(join(root, "deno.local.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const overrides = {};
  for (const [specifier, path] of Object.entries(config.imports ?? {})) {
    if (!specifier.startsWith("@lapismd/") || !path.startsWith(".")) continue;
    const name = specifier.split("/").slice(0, 2).join("/");
    let directory = dirname(resolve(root, path));
    while (dirname(directory) !== directory) {
      try {
        const manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
        if (manifest.name === name) {
          overrides[name] = directory;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  return overrides;
}

async function prune(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      ["__tests__", "tests", "test", "examples", "benchmark", "bench"].includes(
        entry.name,
      ) ||
      /\.(?:map|d\.[cm]?ts|test\.[cm]?[jt]s|spec\.[cm]?[jt]s)$/.test(entry.name)
    )
      await rm(path, { recursive: true, force: true });
    else if (entry.isDirectory()) await prune(path);
  }
}
