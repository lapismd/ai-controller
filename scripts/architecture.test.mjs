import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { countedLines } from "./architecture-lines.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const checker = path.join(repoRoot, "scripts/check-architecture.mjs");
const fixtures = path.join(repoRoot, "scripts/architecture-fixtures");

function run(name, extra = [], env = {}) {
  return spawnSync(
    process.execPath,
    [checker, "--root", path.join(fixtures, name), ...extra],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: { ...process.env, ...env },
    },
  );
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

describe("counted-line metric", () => {
  it("ignores blank lines and comment-only lines", () => {
    expect(
      countedLines(
        [
          "export const n = 1;",
          "",
          "// comment",
          "/* block */",
          "/**",
          " * docs",
          " */",
          "export const m = 2;",
          "<!-- html -->",
        ].join("\n"),
      ),
    ).toBe(2);
  });
});

describe("architecture checker fixtures", { timeout: 30_000 }, () => {
  it("fails a new production file over 300 counted lines", () => {
    const result = run("new-oversize");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("new-file-budget");
  });

  it("fails counted-line growth of an existing file", () => {
    const result = run("growth");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("counted-line-growth");
  });

  it("passes a valid extraction with updated budgets", () => {
    const result = run("extraction");
    expect(output(result)).not.toMatch(
      /\[(?:new-file-budget|counted-line-growth)\]/,
    );
    expect(result.status).toBe(0);
  });

  it("fails a generic dump filename", () => {
    const result = run("dump-filename");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("dump-filename");
  });

  it("fails a relative forbidden import", () => {
    const result = run("forbidden-relative");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("forbidden-import");
  });

  it("fails a CLI import of controller", () => {
    const result = run("cli-controller");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("forbidden-import");
  });

  it("follows one value re-export hop", () => {
    const result = run("reexport");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("forbidden-import");
  });

  it("fails a literal dynamic import of controller", () => {
    const result = run("dynamic-import");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("forbidden-import");
  });

  it("fails a computed import()", () => {
    const result = run("computed-import");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("non-literal-import");
  });

  it("fails a runtime cycle", () => {
    const result = run("cycle");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("runtime-cycle");
  });

  it("allows composition roots to import controller", () => {
    const result = run("composition-root");
    expect(result.status).toBe(0);
    expect(output(result)).not.toContain("forbidden-import");
  });

  it("allows a configured type-only store import from protocol", () => {
    const result = run("type-import");
    expect(result.status).toBe(0);
    expect(output(result)).not.toContain("forbidden-import");
  });

  it("fails a value import where only types are allowed", () => {
    const result = run("type-import-value");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("forbidden-import");
  });

  it("allows tests to import internals", () => {
    const result = run("test-imports");
    expect(result.status).toBe(0);
  });

  it("fails production imports of tests", () => {
    const result = run("production-test-import");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("production-test-import");
  });

  it("allows a cohesive baseline exception over the new-file limit", () => {
    const result = run("exception");
    expect(result.status).toBe(0);
  });

  it("fails when a baseline path is missing on disk", () => {
    const result = run("rename-missing");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("missing-baseline-path");
  });

  it("walks new .mts files", () => {
    const result = run("new-mts");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("new-file-budget");
  });

  it("fails when the baseline JSON is missing", () => {
    const result = run("missing-baseline");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("architecture-baseline-missing");
  });

  it("fails when the root has no source files", () => {
    const result = run("empty-root");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("no-inputs");
  });

  it("passes a comment-only edit that does not change counted lines", () => {
    const result = run("comment-only");
    expect(result.status).toBe(0);
    expect(output(result)).not.toContain("counted-line-growth");
  });

  it("fails stale budgets when metric plus slack is under the budget", () => {
    const result = run("stale-budget");
    expect(result.status).toBe(1);
    expect(output(result)).toContain("stale-budget");
  });

  it("refuses --write-baseline when CI=true", () => {
    const result = run("empty-root", ["--write-baseline"], { CI: "true" });
    expect(result.status).toBe(1);
    expect(output(result)).toContain("write-baseline-forbidden");
  });
});

describe("repository architecture baseline", () => {
  it("passes the current tree", { timeout: 60_000 }, () => {
    const result = spawnSync(process.execPath, [checker], {
      encoding: "utf8",
      cwd: repoRoot,
      env: process.env,
      timeout: 55_000,
    });
    if (result.status !== 0) {
      expect(output(result)).toBe("expected check:architecture to pass");
    }
    expect(result.status).toBe(0);
  });
});
