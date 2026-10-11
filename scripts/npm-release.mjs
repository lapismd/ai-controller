import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = path.join(root, ".local/npm-release");
const manifestPath = path.join(artifactDir, "manifest.json");

export function hashes(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export function verifyArtifact(manifest, bytes, expectedCommit) {
  assert.equal(manifest.schema, "lapis.npm-release/1");
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(manifest.packageName, /^@lapismd\/[a-z0-9-]+$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.filename, path.basename(manifest.filename));
  assert.match(manifest.filename, /^[a-z0-9.-]+\.tgz$/);
  if (expectedCommit) assert.equal(manifest.sourceCommit, expectedCommit);
  assert.equal(manifest.sha256, hashes(bytes).sha256);
  assert.equal(manifest.integrity, hashes(bytes).integrity);
}

async function prepare() {
  await mkdir(artifactDir, { recursive: true });
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const range of Object.values(pkg[field] ?? {})) {
      assert.doesNotMatch(range, /^(?:file|link|workspace):/);
    }
  }
  const output = run("pnpm", [
    "pack",
    "--json",
    "--pack-destination",
    artifactDir,
  ]);
  const packed = JSON.parse(output.slice(output.indexOf("{")));
  const filename = path.basename(packed.filename);
  const tarball = path.join(artifactDir, filename);
  const metadata = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"]),
  );
  assert.equal(metadata.name, pkg.name);
  assert.equal(metadata.version, pkg.version);
  const sourceCommit =
    process.env.GITHUB_SHA ??
    process.env.LAPIS_RELEASE_COMMIT ??
    run("jj", [
      "--no-pager",
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "commit_id",
    ]);
  const bytes = await readFile(tarball);
  const manifest = {
    schema: "lapis.npm-release/1",
    packageName: pkg.name,
    version: pkg.version,
    sourceCommit,
    filename,
    ...hashes(bytes),
    files: packed.files.map((file) => file.path).sort(),
  };
  verifyArtifact(manifest, bytes, sourceCommit);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${pkg.name}@${pkg.version}: ${manifest.sha256}`);
}

async function candidate() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tarball = path.join(artifactDir, manifest.filename);
  verifyArtifact(manifest, await readFile(tarball), process.env.GITHUB_SHA);
  const pkg = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(manifest.packageName, pkg.name);
  assert.equal(manifest.version, pkg.version);
  const packed = JSON.parse(
    run("tar", ["-xOf", tarball, "package/package.json"]),
  );
  assert.equal(packed.name, manifest.packageName);
  assert.equal(packed.version, manifest.version);
  return { manifest, tarball };
}

async function registryPackage(name) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  );
  if (response.status === 404) return undefined;
  assert.equal(response.status, 200);
  return response.json();
}

async function publish() {
  assert.equal(process.env.LAPIS_NPM_RELEASE_APPROVED, "1");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  const { manifest, tarball } = await candidate();
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    `lapismd/${manifest.packageName.split("/")[1]}`,
  );
  const registry = await registryPackage(manifest.packageName);
  assert.ok(
    registry,
    "Initial package creation is required before npm trusted publishing can be configured.",
  );
  const existing = registry.versions?.[manifest.version];
  if (existing) {
    assert.equal(existing.dist.integrity, manifest.integrity);
    console.log("Registry version already matches the verified artifact.");
    return;
  }
  run("npm", ["publish", tarball, "--access", "public", "--provenance"], {
    stdio: "inherit",
  });
}

async function verify() {
  const { manifest } = await candidate();
  const registry = await registryPackage(manifest.packageName);
  assert.equal(
    registry?.versions?.[manifest.version]?.dist?.integrity,
    manifest.integrity,
  );
  const consumer = await mkdtemp(path.join(os.tmpdir(), "lapis-npm-consumer-"));
  try {
    await writeFile(
      path.join(consumer, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `${manifest.packageName}@${manifest.version}`,
      ],
      { cwd: consumer, stdio: "inherit" },
    );
    run("npm", ["audit", "signatures"], { cwd: consumer, stdio: "inherit" });
    const entry =
      manifest.packageName === "@lapismd/lapis-community"
        ? `${manifest.packageName}/protocol`
        : manifest.packageName === "@lapismd/ai-controller"
          ? `${manifest.packageName}/client`
          : manifest.packageName;
    run(
      "node",
      ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`],
      { cwd: consumer, stdio: "inherit" },
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
  console.log(
    `Verified registry integrity and clean consumer for ${manifest.packageName}@${manifest.version}.`,
  );
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  })?.trim();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const handlers = { prepare, publish, verify };
  assert.ok(
    handlers[process.argv[2]],
    "Usage: npm-release.mjs prepare|publish|verify",
  );
  await handlers[process.argv[2]]();
}
