# Shared controller migration record

Approved 2026-09-16. Scope: standalone controller; keep ai-host execution as a
library; preserve both memory stores; preserve Nostr privacy; conservative
crash recovery. Both full consumers, including native Codex and private/forum
Nostr paths, are required before removing the old execution path.

## Source baseline

| Repository | Revision | Focused tests |
| --- | --- | --- |
| ai-host | 5f963c86756c | 58 passed |
| lapis-plugins | 4a6b6bf44d19 | 100 passed |
| nostr-agent-controller | f69ef5e4ae4d | 34 passed |
| lapis-notes | 17ab470a5495 | Host integration inspected |

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
