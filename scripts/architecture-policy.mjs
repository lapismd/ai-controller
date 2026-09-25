/** Feature layers, composition-root globs, and the AIC-ARCH-001 import matrix. */

export const LIMIT_KEYS = {
  production: "newProductionCountedLines",
  test: "newTestCountedLines",
  script: "newScriptCountedLines",
};

export const DEFAULT_LIMITS = {
  newProductionCountedLines: 300,
  newTestCountedLines: 500,
  newScriptCountedLines: 300,
};

export const DUMP_NAMES = new Set(["utils", "helpers", "common", "services"]);

const FEATURES = new Set([
  "auth",
  "capture",
  "cli",
  "domain",
  "execution",
  "memory",
  "persistence",
  "transport",
  "protocol",
  "store",
  "controller",
  "testing",
]);

/** Residual root owners after keeping the existing folder taxonomy. */
export const FILE_LAYER = {
  "src/contracts.ts": "contracts",
  "src/policy-contracts.ts": "contracts",
  "src/transcript-contracts.ts": "contracts",
  "src/client.ts": "client",
  "src/runtime.ts": "runtime",
  "src/managed.ts": "runtime",
};

const COMPOSITION_FILES = new Set([
  "src/index.ts",
  "src/main.ts",
  "src/service.ts",
]);

export const ALLOWED_DYNAMIC = new Set();

const R = "R";
const T = "T";
const X = "X";

const LAYERS = [
  "contracts",
  "capture",
  "auth",
  "persistence",
  "execution",
  "memory",
  "domain",
  "transport",
  "client",
  "runtime",
  "cli",
  "protocol",
  "store",
  "controller",
  "testing",
];

function row(from, overrides = {}) {
  return Object.fromEntries(
    LAYERS.map((layer) => [
      layer,
      layer === from ? R : (overrides[layer] ?? X),
    ]),
  );
}

/**
 * Rows import columns. Copied fixtures keep protocol/store/controller/cli
 * names. Claimed production edges: cli must not own domain, memory, or
 * persistence; execution must not import transport; client and runtime stay
 * out of persistence.
 */
export const MATRIX = {
  contracts: row("contracts"),
  capture: row("capture", { contracts: R, domain: T, execution: R }),
  auth: row("auth", { contracts: R }),
  persistence: row("persistence", { capture: R, contracts: R }),
  execution: row("execution", { contracts: R, domain: T }),
  memory: row("memory", { capture: R, contracts: R, execution: R }),
  domain: row("domain", {
    auth: R,
    capture: R,
    contracts: R,
    execution: T,
    memory: R,
    persistence: R,
  }),
  transport: row("transport", {
    auth: R,
    capture: R,
    contracts: R,
    domain: R,
    memory: R,
  }),
  client: row("client", { contracts: R }),
  runtime: row("runtime", { client: R, contracts: T, execution: R }),
  cli: row("cli", { auth: R, client: R, contracts: R, runtime: R }),
  protocol: row("protocol", { store: T }),
  store: row("store"),
  controller: row("controller"),
  testing: Object.fromEntries(LAYERS.map((layer) => [layer, R])),
};

const FATAL_EDGES = new Set([
  "cli>controller",
  "protocol>controller",
  "cli>domain",
  "cli>memory",
  "cli>persistence",
  "execution>transport",
  "client>persistence",
  "client>domain",
  "client>memory",
  "runtime>persistence",
]);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/u;

export function isSourceFile(name) {
  return SOURCE_EXT.test(name);
}

export function toPosix(relativePath) {
  return relativePath.split("\\").join("/");
}

export function isCompositionRoot(posixPath) {
  return COMPOSITION_FILES.has(posixPath);
}

export function fileKind(posixPath) {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(posixPath)) return "test";
  if (posixPath.startsWith("scripts/") || posixPath.startsWith("bin/"))
    return "script";
  return "production";
}

export function layerOf(posixPath) {
  const match = posixPath.match(/^src\/([^/]+)\//u);
  if (match) {
    if (match[1] === "__tests__") return "testing";
    if (FEATURES.has(match[1])) return match[1];
  }
  if (FILE_LAYER[posixPath]) return FILE_LAYER[posixPath];
  if (posixPath.startsWith("src/")) return "other";
  return "scripts";
}

export function isDumpPath(posixPath) {
  const parts = posixPath.split("/");
  const base = (parts.at(-1) ?? "").replace(/\.(?:[cm]?[jt]sx?)$/u, "");
  if (DUMP_NAMES.has(base)) return true;
  return parts.slice(0, -1).some((part) => DUMP_NAMES.has(part));
}

export function isTestLike(posixPath) {
  return fileKind(posixPath) === "test";
}

export function isTestingPath(posixPath) {
  return (
    posixPath.startsWith("src/testing/") ||
    posixPath.startsWith("src/__tests__/") ||
    isTestLike(posixPath)
  );
}

export function matrixCell(fromLayer, toLayer) {
  if (fromLayer === "other" || fromLayer === "scripts") return R;
  if (toLayer === "other" || toLayer === "scripts") return R;
  return MATRIX[fromLayer]?.[toLayer] ?? X;
}

export function isPendingTypeEdge() {
  return false;
}

export function featureBarrel(posixPath) {
  const match = posixPath.match(/^(src\/[^/]+)\/index\.[cm]?[jt]sx?$/u);
  return match?.[1] ?? null;
}

export function isSelfBarrelImport(importer, imported) {
  const parent = importer.match(/^(src\/[^/]+)\//u)?.[1];
  if (!parent || parent === "src/__tests__") return false;
  if (importer === `${parent}/index.ts` || importer === `${parent}/index.js`)
    return false;
  return (
    imported === `${parent}/index.ts` || imported === `${parent}/index.js`
  );
}

export function isFatalEdge(fromLayer, toLayer) {
  return FATAL_EDGES.has(`${fromLayer}>${toLayer}`);
}

export const HOTSPOT_JUSTIFICATIONS = {
  "src/memory/lapis/native-memory-service.ts":
    "Lapis memory compatibility; split with the extracted production boundary",
  "src/memory/group/service.ts":
    "Group memory compatibility; split with the extracted production boundary",
  "src/domain/engine.ts":
    "Turn engine facade; split commands into named domain modules",
  "src/persistence/store.ts":
    "SQLite store facade; split by durable concern",
  "src/transport/server.ts":
    "WebSocket host facade; split dispatch from serve",
  "src/client.ts":
    "Public ./client facade; split snapshot and subscription helpers",
  "src/runtime.ts":
    "Public ./runtime facade; split only if a later change needs room",
  "src/execution/acp.ts":
    "ACP provider; split only if a later change needs room",
  "src/execution/compat/codex-runtime.ts":
    "Native Codex adapter; split only if a later change needs room",
  "src/cli/service.ts":
    "OS service wrappers; split only if a later change needs room",
  "src/execution/compat/app-server-protocol.ts":
    "App-server protocol; split only if a later change needs room",
  "src/execution/compat/acp-event-mapper.ts":
    "ACP event mapping; split only if a later change needs room",
  "src/cli/main.ts":
    "CLI command table; split only if a later change needs room",
  "src/execution/codex.ts":
    "Codex provider; split only if a later change needs room",
  "src/execution/compat/types.ts":
    "Compat DTO types; split only if a later change needs room",
  "src/transport/server.test.ts":
    "Transport contract suite; split with extracted host surfaces",
  "src/domain/engine.test.ts":
    "Engine suite; split with the extracted production boundary",
  "src/runtime.test.ts":
    "Runtime facade suite; split with extracted client helpers",
  "src/execution/compat/codex-runtime.test.ts":
    "Native Codex suite; split with the adapter boundary",
};
