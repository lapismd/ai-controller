import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { countedLines, physicalLines } from "./architecture-lines.mjs";
import {
  parseModuleImports,
  posixFromRoot,
  resolveSpecifier,
} from "./architecture-imports.mjs";
import {
  fileKind,
  featureBarrel,
  isCompositionRoot,
  isFatalEdge,
  isPendingTypeEdge,
  isSelfBarrelImport,
  isSourceFile,
  isTestLike,
  isTestingPath,
  layerOf,
  matrixCell,
  toPosix,
} from "./architecture-policy.mjs";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "artifacts",
  "spec",
  ".local",
  ".cache",
  ".git",
  ".jj",
]);

export function walkSources(root) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (rel === "scripts/architecture-fixtures") continue;
        visit(full);
        continue;
      }
      if (isSourceFile(entry.name)) files.push(full);
    }
  };
  for (const name of ["src", "scripts", "bin"]) visit(path.join(root, name));
  return files;
}

export function collectGraph(root, files) {
  const parsed = new Map();
  for (const full of files) {
    const posix = posixFromRoot(root, full);
    const source = fs.readFileSync(full, "utf8");
    parsed.set(posix, {
      full,
      posix,
      kind: fileKind(posix),
      layer: layerOf(posix),
      composition: isCompositionRoot(posix),
      counted: countedLines(source),
      physical: physicalLines(source),
      ...parseModuleImports(full, source),
    });
  }
  for (const record of parsed.values()) {
    const resolveOne = (specifier) => {
      const absolute = resolveSpecifier(root, record.full, specifier);
      return absolute ? posixFromRoot(root, absolute) : null;
    };
    record.resolvedImports = record.imports.map((item) => ({
      ...item,
      resolved: resolveOne(item.specifier),
    }));
    record.resolvedReexports = record.reexports.map((item) => ({
      ...item,
      resolved: resolveOne(item.specifier),
    }));
  }
  for (const record of parsed.values()) {
    const hop = [];
    for (const item of record.resolvedImports) {
      if (item.typeOnly || !item.resolved) continue;
      if (featureBarrel(item.resolved)) continue;
      const target = parsed.get(item.resolved);
      if (!target) continue;
      for (const reexport of target.resolvedReexports) {
        if (reexport.typeOnly || !reexport.resolved) continue;
        hop.push({
          specifier: reexport.specifier,
          typeOnly: false,
          line: item.line,
          resolved: reexport.resolved,
          via: item.resolved,
        });
      }
    }
    record.resolvedImports.push(...hop);
  }
  return parsed;
}

export function evaluateImport(record, item) {
  if (!item.resolved) return null;
  if (record.composition || record.kind === "script") return null;
  if (isTestLike(record.posix)) return null;
  if (isSelfBarrelImport(record.posix, item.resolved))
    return { rule: "self-barrel-import", pending: false, fatal: true };
  if (isTestingPath(item.resolved) && record.kind === "production")
    return { rule: "production-test-import", pending: false, fatal: true };
  const toLayer = layerOf(item.resolved);
  const cell = matrixCell(record.layer, toLayer);
  if (cell === "R") return null;
  if (cell === "X") {
    return {
      rule: "forbidden-import",
      pending: false,
      fatal: isFatalEdge(record.layer, toLayer),
    };
  }
  if (cell === "T" && item.typeOnly) {
    if (isPendingTypeEdge(record.layer, toLayer))
      return { rule: "type-import", pending: true };
    return null;
  }
  if (cell === "T")
    return { rule: "forbidden-import", pending: false, fatal: false };
  return { rule: "forbidden-import", pending: false, fatal: false };
}

export function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return null;
  return JSON.parse(fs.readFileSync(baselinePath, "utf8"));
}

export function sourceCommit(root) {
  try {
    return execFileSync(
      "jj",
      [
        "--no-pager",
        "log",
        "-r",
        "@",
        "-n",
        "1",
        "--no-graph",
        "-T",
        "commit_id",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim();
  } catch {
    return "unknown";
  }
}
