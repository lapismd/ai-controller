# Shared controller migration record

Approved 2026-09-16. Scope: standalone controller; keep ai-host execution as a
library; preserve both memory stores; preserve Nostr privacy; conservative
crash recovery. Both full consumers, including native Codex and private/forum
Nostr paths, are required before removing the old execution path.

## Source baseline

| Repository             | Revision     | Focused tests              |
| ---------------------- | ------------ | -------------------------- |
| ai-host                | 5f963c86756c | 58 passed                  |
| lapis-plugins          | 4a6b6bf44d19 | 100 passed                 |
| nostr-agent-controller | f69ef5e4ae4d | 34 passed                  |
| lapis-notes            | 17ab470a5495 | Host integration inspected |

Runtime: Deno 2.9.4, Node 24.10.0, pnpm 10.34.5. Host lock:
acpx 0.13.0, ACP SDK 1.3.0. SQLite creation/query verified under Deno.
T3 reference: ccf220be205f0e509021dbc8cbda90daa638e20d, architecture,
providers, connection runtime, orchestration engine and provider adapter.

## Ordered implementation and acceptance

1. Durable core, fake execution, SDK and CLI: receipts, work discovery, private
   payload policy, snapshots, interactions and process recovery.
2. Host adapter and native Codex: capability and provider instance isolation,
   early-event capture, truthful interruption, MCP routing.
3. Memory: record/search/evidence adapters, preserve retrieval and tool names,
   extraction and maintenance policies, deletion and external-edit handling.
4. Lapis: controller facade, UI projection and vault adapters; desktop/web and
   Storybook service attach; exact existing behavior and live handoff acceptance.
5. Nostr: SDK execution, domain tools/context and memory adapters; retain signing,
   domain outbox, private content handling, processing controls and local e2e.
6. Remove duplicate consumer orchestration and host bins after parity; full
   required checks, built public-package acceptance, migration/rollback guide.

## Extraction map

- Host executor, ACP registry/configuration, MCP broker: retain in ai-host.
- Host CLI/service/shim entrypoints: move to controller after consumer acceptance.
- Lapis chat session/provider/handoff logic: controller adapters and context.
- Lapis NativeMemoryService, candidate extraction, scheduler: shared memory.
- Lapis VaultMemoryRecordStore, ConversationRepository, AppDatabase: app adapters.
- Nostr ControllerMemoryService: shared memory with group profile.
- Nostr ControllerStore evidence/search access: integration storage adapter.
- Nostr scheduler/runtime-client: shared controller execution and SDK.
- Nostr routing, persona authorization, signers, relay tools/outbox: remain Nostr.

No publication or deployment is implied. Development acceptance may use ignored
local configurations against built sibling packages; committed manifests retain
registry ranges. Never execute old and new paths for the same turn.

## Milestone 1 checkpoint — 2026-09-16

Implemented in `src/persistence`, `src/domain`, `src/transport`, `src/client.ts`,
`src/execution` and `src/cli`: durable intent and receipts, private payload
redaction, FIFO workspace scheduling, early output capture, conservative recovery,
scoped WebSocket SDK, authenticated application endpoints, approvals/input,
ACP execution adapter, native Codex protocol extraction, and Deno service CLI.
The generic memory module now contains compatibility ranking/recall policies;
remote memory preparation and read tools have an end-to-end fixture.

Verification: `pnpm check`, `pnpm test` (29 tests), `pnpm build`, `pnpm publint`,
`pnpm spec:check`, `pnpm build:cli`, and `node scripts/smoke-cli.mjs` passed.
The compiled CLI smoke covers initialization, scoped auth, provider discovery,
thread creation, process restart with persisted state, and clean shutdown.
Provider protocol fixtures are simulated, not evidence of native crash recovery.

The host dependency was built from local revision 5f963c86756c. The npm 0.1.0
release lacks its current `runMcpShim` export. Validation uses the ignored
`.local/pnpmfile.cjs` hook and a locally packed host tarball; the manifest and
lockfile retain registry dependencies. Reproduce after packing the local host:
`pnpm install --lockfile=false --config.pnpmfile=.local/pnpmfile.cjs`.
Release requires a host version that includes the public shim export.

Still required: complete native adapter conformance/fault coverage; extract full
memory storage/evidence/maintenance orchestration; migrate Lapis runtime, chat,
desktop/web/Storybook attach; migrate Nostr domain adapters and all conversation
paths; complete management commands; remove old orchestration and host runnable
entrypoints only after full consumer acceptance. Neither application has switched
execution ownership at this checkpoint. No service was installed or deployed.

## Memory extraction checkpoint

Shared compatibility implementations now live under `src/memory/lapis` and
`src/memory/group`. Lapis receives structural database/evidence/record ports;
group memory receives its existing partitioned SQLite operations and an injected
embedding worker port. Both profiles share MMR selection while retaining their
existing score normalization difference. Source data schemas are unchanged.

The Lapis service/scheduler facade passes all 32 original memory tests, all 360
AI package tests, type checks, build and publint; all 53 AI Storybook interaction
tests also passed from a fresh runner. Local package installation initially
produced three nominal App type errors due to divergent API peer graphs. The
ignored validation hook pins compatible CodeMirror/Mira/TypeScript peer versions;
the same check now reports zero errors and zero warnings. Tracked ranges remain
unchanged except the new controller dependency.

The Nostr memory facade passes its 10 original memory tests and the full 134-test
suite. Deno type checks passed using `artifacts/controller/deno.json`, which
preserves the existing local import map and links the unpublished controller.
Normal registry-only consumer installation cannot resolve the new package until
publication. No registry lockfile entry or integrity has been fabricated.

## Session facade and management checkpoint

The browser-safe runtime facade now consumes ordered committed transcript events,
reconnects without replaying execution, and resolves lost prompt acknowledgements
by command identity. It rejects concurrent submissions before acknowledgement and
reports provider approval capabilities conservatively. ACP reasoning and tool
activity use the shared normalized event mapper. The CLI exposes model discovery,
optimistic thread configuration, paginated event reads, tool manifests and live
interaction inspection. Observer queues and transcript snapshots are bounded.

Verification: 39 controller tests pass, including facade reconnect during approval,
lost-ACK/concurrent-send regression, configuration conflicts and authenticated CLI
management. Type/boundary checks, build, specification checks, publint, Deno compile
and compiled restart/shutdown smoke pass. A configuration-fixture failure was
corrected by emitting the provider's accepted activity before waiting for abort;
no production assertion or behavior was relaxed.

The Nostr memory extraction additionally passes the disposable relay-stack test:
13 plugins, hydration, roles, managed-agent restart reconnect, persistence and
Keytr reset/verification. This test uses the locally compiled controller adapter;
it does not establish completion of the execution migration.

## Managed service boundary checkpoint

The shared package now exports a managed-process client that launches the
separate executable. Credentials use stdin, startup/shutdown are bounded, and
both managed and operator modes share service composition. Provider registries
preserve external executable argv; restricted sessions reject application tools.
Remote endpoint cancellation now reaches application handlers, and an unconfirmed
tool result remains unknown without redispatch. Journal subscriptions deliver
ordered pages and retry failed domain projection commits at the same event.

The host declaration regression was reproduced with three unused negative type
assertions in a NodeNext consumer. The owner build now normalizes relative ESM
declaration imports. The exact regression passes and all 110 host tests pass.
This is an upstream declaration correction, not a consumer type shim.

The Lapis memory facade removes 2,900 lines of duplicate implementation. Its final
memory suite (32), package suite (360), type checks, build/publint/npm-pack,
specification/App ownership checks and fresh AI Storybook lane (53) pass. The
archive validates and reproduces byte for byte; all 12 archive/signature fixture
tests pass. No production signing or publication was performed.

The managed-service slice passes 44 tests plus type/browser-boundary checks,
specification validation, Deno compilation, CLI restart smoke and publint.
No running application has switched to the service yet. The journal path has
its own 1,010-event replay/fault fixture, and remote tool cancellation has an
end-to-end endpoint fixture. Integration deployment is still pending.

## Recovery and attachment hardening

The shared runtime validates the stored application reference, context/tool/memory
bindings, retention and restricted mode before session reattachment. Provider setup
now precedes the durable dispatch boundary. A provider interrupt acknowledgement
alone does not release workspace execution. Native terminal confirmation completes
cancellation; missing confirmation produces an interrupted state and fences queued
work, including after restart. Owners can inspect and explicitly resolve uncertain
turns using `turns resolve --turn ID --outcome failed --stopped` after verifying the
external agent stopped. This operation records an audit event and never retries the
original command.

The setup-failure, uncertain-workspace, native-cancellation and attachment regressions
were reproduced before their fixes. All 57 controller tests, check/boundary validation,
specification checks, generated CLI reference, build and publint pass.
