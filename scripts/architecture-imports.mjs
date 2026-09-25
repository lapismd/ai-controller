/**
 * First-party import graph for the architecture checker.
 * Value re-exports are followed one hop; type-only re-exports are not.
 * This package has no public subpath aliases; package specifiers are unresolved.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ALLOWED_DYNAMIC, toPosix } from "./architecture-policy.mjs";

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function specifierOf(node) {
  if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
    return node.moduleSpecifier.text;
  return null;
}

function stringLiteralText(node) {
  let current = node;
  while (current) {
    if (ts.isStringLiteralLike(current)) return current.text;
    if (
      ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return null;
  }
  return null;
}

export function parseModuleImports(filename, source) {
  const imports = [];
  const reexports = [];
  const nonLiteral = [];
  const tree = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  visit(tree, (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = specifierOf(node);
      if (!spec) return;
      const clause = node.importClause;
      const named =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : [];
      const hasValue =
        !clause ||
        (!clause.isTypeOnly &&
          (Boolean(clause.name) ||
            (clause.namedBindings &&
              ts.isNamespaceImport(clause.namedBindings)) ||
            named.some((el) => !el.isTypeOnly) ||
            named.length === 0));
      imports.push({
        specifier: spec,
        typeOnly: !hasValue,
        line: source.slice(0, node.getStart(tree)).split("\n").length,
      });
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = specifierOf(node);
      if (!spec) return;
      reexports.push({
        specifier: spec,
        typeOnly: Boolean(node.isTypeOnly),
      });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      const line = source.slice(0, node.getStart(tree)).split("\n").length;
      const literal = arg ? stringLiteralText(arg) : null;
      if (!literal) {
        nonLiteral.push({ line });
        return;
      }
      if (ALLOWED_DYNAMIC.has(literal)) return;
      imports.push({ specifier: literal, typeOnly: false, line });
      return;
    }
    if (
      ts.isImportTypeNode(node) &&
      node.argument &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      imports.push({
        specifier: node.argument.literal.text,
        typeOnly: true,
        line: source.slice(0, node.getStart(tree)).split("\n").length,
      });
    }
  });
  return { imports, reexports, nonLiteral };
}

const CANDIDATE_EXT = ["", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".js"];

function fileIfExists(candidate) {
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveSpecifier(_root, fromFile, specifier) {
  if (specifier.startsWith("@") || !/^[./]/u.test(specifier)) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  return resolveExisting(base);
}

function resolveExisting(base) {
  const withoutJs = base.endsWith(".js") ? base.slice(0, -3) : null;
  const stems = withoutJs ? [withoutJs, base] : [base];
  for (const stem of stems) {
    for (const ext of CANDIDATE_EXT) {
      const hit = fileIfExists(stem + ext);
      if (hit) return hit;
    }
    for (const index of ["index.ts", "index.js"]) {
      const hit = fileIfExists(path.join(stem, index));
      if (hit) return hit;
    }
  }
  return null;
}

export function posixFromRoot(root, absolute) {
  return toPosix(path.relative(root, absolute));
}

export function findRuntimeCycles(edges) {
  const cycles = [];
  const seen = new Set();
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const dfs = (node) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      if (start >= 0) {
        const cycle = stack.slice(start).concat(node);
        const key = [...new Set(cycle)].sort().join("\0");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      }
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) dfs(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) dfs(node);
  return cycles;
}
