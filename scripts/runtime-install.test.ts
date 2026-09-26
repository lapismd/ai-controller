import assert from "node:assert/strict";
import { join } from "node:path";
import {
  installRuntime,
  resolveDeno,
  supportedDeno,
} from "./runtime-install.mjs";
import { verifyRuntime, writeManifest } from "./runtime-manifest.mjs";

async function fixture() {
  const home = await Deno.makeTempDir({ prefix: "cli snapshot ' space " });
  const source = join(home, "source");
  await Deno.mkdir(source);
  await Deno.writeTextFile(
    join(source, "cli.js"),
    'console.log(JSON.stringify({version:"fixture",args:Deno.args}));',
  );
  const build = {
    version: "0.1.0",
    revision: "a".repeat(40),
    builtAt: "2026-01-01T00:00:00Z",
  };
  await writeManifest(source, {
    command: "fixture-cli",
    build,
    minimumDeno: "2.9.5",
  });
  return {
    home,
    source,
    build,
    cleanup: () => Deno.remove(home, { recursive: true }),
  };
}
Deno.test("Deno version floor and missing runtime fail clearly", () => {
  for (const version of ["2.9.5", "2.9.7", "2.10.0", "3.0.0"])
    assert.equal(supportedDeno(version), true);
  for (const version of ["2.9.4", "2.8.9", "1.46.0", "invalid"])
    assert.equal(supportedDeno(version), false);
  assert.throws(() => resolveDeno("/nonexistent/deno"), /Deno 2.9.5/);
});
Deno.test(
  "bare command runs outside the checkout with literal argument bytes",
  async () => {
    const f = await fixture();
    try {
      const installed = await installRuntime(f.source, { home: f.home });
      const args = ["space value", "quote'", "$literal", "line\nbreak"];
      const result = await new Deno.Command("/bin/sh", {
        args: ["-c", 'exec fixture-cli "$@"', "sh", ...args],
        cwd: "/tmp",
        env: { PATH: join(f.home, ".local/bin") },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(result.stdout)).args,
        args,
      );
      assert.equal((await Deno.stat(installed.path)).mode! & 0o777, 0o755);
      assert.deepEqual((await verifyRuntime(installed.release)).build, f.build);
    } finally {
      await f.cleanup();
    }
  },
);
Deno.test(
  "checkout edits and removal cannot change installed code or identity",
  async () => {
    const f = await fixture();
    try {
      const installed = await installRuntime(f.source, { home: f.home });
      await Deno.remove(f.source, { recursive: true });
      const result = await new Deno.Command(installed.path, {
        stdout: "piped",
      }).output();
      assert.equal(result.code, 0);
      assert.deepEqual((await verifyRuntime(installed.release)).build, f.build);
    } finally {
      await f.cleanup();
    }
  },
);
Deno.test("failed smoke preserves launcher and previous snapshot", async () => {
  const f = await fixture();
  try {
    const first = await installRuntime(f.source, { home: f.home });
    const launcher = await Deno.readTextFile(first.path);
    await Deno.writeTextFile(join(f.source, "cli.js"), "Deno.exit(9);");
    await writeManifest(f.source, { command: "fixture-cli", build: f.build });
    await assert.rejects(
      () => installRuntime(f.source, { home: f.home }),
      /smoke failed/,
    );
    assert.equal(await Deno.readTextFile(first.path), launcher);
    await verifyRuntime(first.release);
  } finally {
    await f.cleanup();
  }
});
Deno.test(
  "successful updates retain old snapshot and respect custom paths",
  async () => {
    const f = await fixture();
    try {
      const installPath = join(f.home, "custom path", "fixture-cli");
      const first = await installRuntime(f.source, {
        home: f.home,
        installPath,
      });
      await Deno.writeTextFile(join(f.source, "extra.json"), "{}");
      await writeManifest(f.source, { command: "fixture-cli", build: f.build });
      const second = await installRuntime(f.source, {
        home: f.home,
        installPath,
      });
      assert.notEqual(first.digest, second.digest);
      assert.equal(second.path, installPath);
      await verifyRuntime(first.release);
      await verifyRuntime(second.release);
    } finally {
      await f.cleanup();
    }
  },
);
Deno.test("modified content and external links fail closed", async () => {
  const f = await fixture();
  try {
    await Deno.writeTextFile(join(f.source, "cli.js"), "changed");
    await assert.rejects(() => verifyRuntime(f.source), /checksum/);
    await Deno.symlink("/tmp", join(f.source, "escape"));
    await assert.rejects(
      () => writeManifest(f.source, { command: "fixture-cli" }),
      /escapes/,
    );
  } finally {
    await f.cleanup();
  }
});
Deno.test(
  "prepared install can run without network or a Deno command on PATH",
  async () => {
    const f = await fixture();
    try {
      const installed = await installRuntime(f.source, { home: f.home });
      const result = await new Deno.Command(installed.path, {
        env: { PATH: "/nonexistent", DENO_NO_PROMPT: "1" },
        stdout: "piped",
      }).output();
      assert.equal(result.code, 0);
    } finally {
      await f.cleanup();
    }
  },
);
