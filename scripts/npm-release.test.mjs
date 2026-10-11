import assert from "node:assert/strict";
import { test } from "vitest";
import { hashes, verifyArtifact } from "./npm-release.mjs";

const bytes = Buffer.from("verified release candidate");
const sourceCommit = "a".repeat(40);
const manifest = {
  schema: "lapis.npm-release/1",
  packageName: "@lapismd/agent-redaction",
  version: "0.1.0",
  sourceCommit,
  filename: "lapismd-agent-redaction-0.1.0.tgz",
  ...hashes(bytes),
};

test("verified candidate rejects changed bytes and source commit", () => {
  verifyArtifact(manifest, bytes, sourceCommit);
  assert.throws(() =>
    verifyArtifact(manifest, Buffer.from("changed"), sourceCommit),
  );
  assert.throws(() => verifyArtifact(manifest, bytes, "b".repeat(40)));
});

test("candidate rejects path traversal and mismatched npm integrity", () => {
  assert.throws(() =>
    verifyArtifact({ ...manifest, filename: "../candidate.tgz" }, bytes),
  );
  assert.throws(() =>
    verifyArtifact({ ...manifest, integrity: "sha512-invalid" }, bytes),
  );
});
