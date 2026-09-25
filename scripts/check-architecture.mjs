#!/usr/bin/env node
/**
 * AIC-ARCH-001 architecture checker: counted-line budgets, feature import
 * matrix, dump filenames, runtime cycles, and production isolation from tests.
 *
 * Re-export hop: follows one value `export * from` / `export { x } from`
 * except through feature barrels (`src/<feature>/index.*`). Type-only
 * re-exports are not followed. This package has no public subpath aliases,
 * so package specifiers are not resolved as first-party edges.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findRuntimeCycles } from "./architecture-imports.mjs";
import {
  DEFAULT_LIMITS,
  HOTSPOT_JUSTIFICATIONS,
  LIMIT_KEYS,
  isDumpPath,
  layerOf,
  toPosix,
} from "./architecture-policy.mjs";
import {
  collectGraph,
  evaluateImport,
  readBaseline,
  sourceCommit,
  walkSources,
} from "./architecture-scan.mjs";

export function parseArgs(argv) {
  const options = { writeBaseline: false, root: process.cwd(), baseline: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write-baseline") options.writeBaseline = true;
    else if (arg === "--root") options.root = path.resolve(argv[++i] ?? "");
    else if (arg === "--baseline")
      options.baseline = path.resolve(argv[++i] ?? "");
  }
  return options;
}

export function checkArchitecture({
  root,
  writeBaseline = false,
  baselinePath,
  ci = process.env.CI === "true",
} = {}) {
  const repoRoot = path.resolve(root ?? process.cwd());
  const baselineFile =
    baselinePath ?? path.join(repoRoot, "scripts/architecture-baseline.json");
  const errors = [];
  const warnings = [];
  const report = (list, rule, message, file, line) => {
    list.push({ rule, message, file, line });
    const loc = [file, line].filter(Boolean).join(":");
    const text = `${loc ? `${loc} ` : ""}[${rule}] ${message}`;
    if (list === errors) console.error(text);
    else console.log(text);
  };

  if (ci && writeBaseline) {
    report(
      errors,
      "write-baseline-forbidden",
      "Refusing --write-baseline because CI=true",
    );
    return { ok: false, errors, warnings };
  }

  const files = walkSources(repoRoot);
  if (files.length === 0) {
    report(errors, "no-inputs", "architecture check found no source files");
    return { ok: false, errors, warnings };
  }

  const graph = collectGraph(repoRoot, files);
  const baseline = writeBaseline ? { files: {} } : readBaseline(baselineFile);
  if (!writeBaseline && !baseline) {
    report(
      errors,
      "architecture-baseline-missing",
      `architecture baseline missing: ${toPosix(path.relative(repoRoot, baselineFile)) || baselineFile}`,
    );
    return { ok: false, errors, warnings };
  }

  const limits = { ...DEFAULT_LIMITS, ...(baseline?.limits ?? {}) };
  const recorded = baseline?.files ?? {};
  if (!writeBaseline) {
    for (const posix of Object.keys(recorded)) {
      if (!graph.has(posix))
        report(
          errors,
          "missing-baseline-path",
          `deleted or renamed; update baseline in this change: ${posix}`,
          posix,
        );
    }
  }

  const runtimeEdges = new Map();
  const snapshot = {};
  for (const record of graph.values()) {
    if (isDumpPath(record.posix))
      report(
        errors,
        "dump-filename",
        "generic dump filename or directory is not allowed",
        record.posix,
      );
    const forbidden = new Map();
    for (const item of record.nonLiteral) {
      if (record.kind !== "production") continue;
      report(
        errors,
        "non-literal-import",
        "Computed import() is not a string literal",
        record.posix,
        item.line,
      );
    }
    for (const item of record.resolvedImports) {
      if (!item.typeOnly && item.resolved) {
        const list = runtimeEdges.get(record.posix) ?? new Set();
        list.add(item.resolved);
        runtimeEdges.set(record.posix, list);
      }
      const verdict = evaluateImport(record, item);
      if (!verdict || forbidden.has(item.resolved)) continue;
      const message = `${record.layer} → ${layerOf(item.resolved)} via ${item.specifier}${
        item.via ? ` (re-export ${item.via})` : ""
      }`;
      forbidden.set(item.resolved, { verdict, item, message });
    }
    const priorCount = recorded[record.posix]?.forbiddenImportCount ?? 0;
    const grew = !writeBaseline && forbidden.size > priorCount;
    for (const { verdict, item, message } of forbidden.values()) {
      if (verdict.pending)
        report(warnings, "type-import", message, record.posix, item.line);
      if (verdict.fatal || grew)
        report(
          errors,
          verdict.pending ? "forbidden-import" : verdict.rule,
          message,
          record.posix,
          item.line,
        );
    }

    const priorEntry = recorded[record.posix];
    const limit = limits[LIMIT_KEYS[record.kind]];
    if (!writeBaseline && !priorEntry) {
      if (record.counted > limit)
        report(
          errors,
          "new-file-budget",
          `new ${record.kind} file ${record.counted}/${limit} counted lines`,
          record.posix,
        );
    } else if (!writeBaseline && priorEntry) {
      const budget = priorEntry.countedLines;
      if (record.counted > budget)
        report(
          errors,
          "counted-line-growth",
          `counted-line growth ${budget} -> ${record.counted}`,
          record.posix,
        );
      else if (record.counted + 20 < budget)
        report(
          errors,
          "stale-budget",
          `${record.posix} metric ${record.counted} + 20 < budget ${budget}`,
          record.posix,
        );
    }

    snapshot[record.posix] = {
      countedLines: record.counted,
      physicalLines: record.physical,
      forbiddenImportCount: forbidden.size,
      ...(record.counted > limit
        ? {
            kind: priorEntry?.kind === "exception" ? "exception" : "legacy",
            justification:
              priorEntry?.justification ??
              HOTSPOT_JUSTIFICATIONS[record.posix] ??
              "Existing file above the new-file counted-line limit; do not grow",
          }
        : {}),
    };
  }

  if (!writeBaseline) {
    for (const cycle of findRuntimeCycles(runtimeEdges))
      report(errors, "runtime-cycle", cycle.join(" -> "), cycle[0]);
  }

  if (writeBaseline) {
    const payload = {
      version: 1,
      sourceCommit: sourceCommit(repoRoot),
      limits,
      files: Object.fromEntries(
        Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(
      `Wrote ${Object.keys(snapshot).length} architecture baseline entries to ${baselineFile}`,
    );
    return { ok: true, errors: [], warnings, files: snapshot };
  }

  return { ok: errors.length === 0, errors, warnings, files: snapshot };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const options = parseArgs(process.argv.slice(2));
  const result = checkArchitecture({
    root: options.root,
    writeBaseline: options.writeBaseline,
    baselinePath: options.baseline,
  });
  process.exitCode = result.ok ? 0 : 1;
}
