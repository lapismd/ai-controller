import {
  mkdtemp,
  mkdir,
  writeFile,
  link,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { materializePackages } from "./runtime-packages.mjs";

it("materializes hard-linked published files independently without unshipped data", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-runtime-links-"));
  try {
    const source = join(root, "node_modules", "runtime-fixture");
    await mkdir(join(source, "dist", "cjs"), { recursive: true });
    await mkdir(join(source, "dist", "esm"), { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "runtime-fixture",
        version: "1.0.0",
        files: ["dist"],
      }),
    );
    const bytes = "export const value = 7;\n";
    await writeFile(join(source, "dist", "cjs", "main.js"), bytes, {
      mode: 0o755,
    });
    await link(
      join(source, "dist", "cjs", "main.js"),
      join(source, "dist", "esm", "main.js"),
    );
    await writeFile(join(source, "unshipped.txt"), "private fixture data");
    expect((await stat(join(source, "dist", "cjs", "main.js"))).nlink).toBe(2);
    const output = join(root, "output");
    await materializePackages(root, output, ["runtime-fixture"]);
    const installed = join(output, "node_modules", "runtime-fixture");
    for (const format of ["cjs", "esm"]) {
      const file = join(installed, "dist", format, "main.js");
      expect(await readFile(file, "utf8")).toBe(bytes);
      expect((await stat(file)).nlink).toBe(1);
      expect((await stat(file)).mode & 0o111).not.toBe(0);
    }
    await expect(stat(join(installed, "unshipped.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("inventories published files without executing dependency prepare scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-runtime-prepare-"));
  try {
    const source = join(root, "node_modules", "runtime-fixture");
    await mkdir(join(source, "dist"), { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "runtime-fixture",
        version: "1.0.0",
        files: ["dist"],
        scripts: { prepare: "node prepare.cjs" },
      }),
    );
    await writeFile(
      join(source, "dist", "main.js"),
      "export const ready = true;\n",
    );
    await writeFile(
      join(source, "prepare.cjs"),
      "require('node:fs').writeFileSync('prepare-ran', 'unexpected'); throw new Error('Dependency prepare must not run');\n",
    );
    const output = join(root, "output");
    await materializePackages(root, output, ["runtime-fixture"]);
    expect(
      await readFile(
        join(output, "node_modules", "runtime-fixture", "dist", "main.js"),
        "utf8",
      ),
    ).toBe("export const ready = true;\n");
    await expect(stat(join(source, "prepare-ran"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
