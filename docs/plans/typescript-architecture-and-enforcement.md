# TypeScript architecture and enforcement

**Status:** P0 landed (`wrutmqys`). Extract in progress. Canonical requirements live in `spec/src`.

**Kind of statements:** **Fact** is observed in this checkout. **Recommendation**
is a chosen policy. Organisation plans under `docs/plans/` are not canonical.

## Recommendation

`@lapismd/ai-controller` is a single TypeScript orchestration package whose
production source is **already foldered**. The failure mode is unbounded growth
inside named facades, plus no machine gate on size or layering.

Chosen approach:

1. Do not introduce nested workspace packages, a generic layered architecture
   tree, or ESLint `max-lines`. Do not invent new folder names.
2. Reuse the nostr-agent-controller / lapis-community architecture checker.
   Rewrite `architecture-policy.mjs` for this package. Do not publish a shared
   npm checker.
3. Land a no-new-debt ratchet first (P0) on the current folders, with an import
   matrix for the claimed layers. Then extract memory, engine, store, server,
   and client facades.

Public contracts stay stable: root `dist/index.js`, `./client`, `./contracts`,
`./memory`, `./runtime`, and `./managed`.

## Existing folders

```text
src/
  index.ts                 # public barrel
  client.ts                # public ./client facade
  runtime.ts               # public ./runtime facade
  managed.ts               # public ./managed process client
  contracts.ts             # public ./contracts
  service.ts               # composition root
  auth/
  capture/
  cli/
  domain/
  execution/
  memory/
  persistence/
  transport/
```

## Phases

- **P0.** AIC-ARCH-001, this plan, checker, baseline, `pnpm check:architecture`.
  No folder moves. Break the `auth`↔`transport` and `contracts`↔`capture`
  runtime cycles so the gate can run.
- **P1.** Skipped: folders already exist.
- **P2.** Extract `native-memory-service`, `memory/group/service`, `engine`,
  `store`, `server`, and `client` until new production files stay at or under
  300 counted lines. Lapis native memory now delegates ingest, search, inspect,
  forget, and consolidation to named modules. Group memory search, claims, and
  lifecycle are extracted.

## Import matrix (summary)

- `cli` must not import `domain`, `memory`, or `persistence`.
- `execution` must not import `transport`.
- `client` and `runtime` must not import `persistence`.
- Composition roots (`src/index.ts`, `src/main.ts`, `src/service.ts`) may
  import features.
