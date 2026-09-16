# Shared AI controller implementation

This record describes the implementation delivered on 2026-09-16. The chronological
investigation, original revisions and earlier checkpoints are in `migration.md`.
Canonical requirements remain in `spec/src/architecture.md`.

## Ownership and call path

| Owner                  | Implementation                                                                                        | Responsibility                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ai-controller          | `src/domain/engine.ts`, `src/persistence/store.ts`, `src/persistence/schemas.ts`                      | Atomic intent/receipt/event storage, eligible-work preparation, workspace serialization, interactions and conservative recovery |
| ai-controller          | `src/execution/acp.ts`, `codex.ts`, `compat/`                                                         | Shared provider adapters, configuration, native events, cancellation and approval/input normalization                           |
| ai-controller          | `src/client.ts`, `src/runtime.ts`                                                                     | Authenticated shared SDK, atomic snapshot/replay, command identity, session facade and deferred context registration            |
| ai-controller          | `src/memory/recall.ts`, `lapis/`, `group/`                                                            | Shared recall policy and extracted compatibility services/maintenance                                                           |
| ai-controller          | `src/cli/`, `src/managed.ts`, `src/service.ts`                                                        | Deno operator CLI, service lifecycle, private managed startup and provider composition                                          |
| ai-host                | `src/executor.ts`, `tool-bridge.ts`, `mcp-shim.ts`, `file-tools/`                                     | acpx/ACP and child-process execution, disposable model discovery, MCP transport and portable file algorithms; no operator bin   |
| lapis-plugins          | `packages/ai/src/lib/host/controller-runtime.ts`, `controller-connection.ts`                          | Thin workspace connection/runtime adapters; first-party runtime factory uses the shared controller                              |
| lapis-plugins          | `packages/ai/src/lib/chat/chat-controller.svelte.ts`, `tools/`, `memory/memory-record-store.ts`       | Authored conversation projection, App/Vault permission policy and source memory storage                                         |
| lapis-notes            | `packages/desktop-deno/src-deno/agent-runtime.ts`, `packages/web/src/controller-connection-bridge.ts` | Managed service lifetime or explicit service attachment and workspace connection descriptors                                    |
| nostr-agent-controller | `src/controller-runtime-client.ts`, `src/managed-host.ts`, `src/controller.ts`                        | Shared SDK adaptation; Nostr routing, source authorization, signer custody and publication/outbox remain local                  |

A Lapis or Nostr prompt registers a stable logical thread and authorized context/tool
endpoints, then submits a command identity. The service commits its receipt before
acknowledging. Once workspace work is eligible, it resolves the live endpoints,
records preparation and dispatches to its provider. Runtime output commits before
publication to SDK subscribers. Applications project that output into their own
notes or encrypted Nostr outbox. They do not reconstruct controller execution from
native session IDs. Provider-native MCP activity is observational, never a second
call to the application's tool handler.

## Memory extraction and compatibility

| Existing responsibility                                                          | Shared destination                                 | Consumer boundary / evidence                                                                          |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Lapis `NativeMemoryService`                                                      | `src/memory/lapis/native-memory-service.ts`        | Structural record, evidence and AppDatabase ports; original 32 consumer memory tests retained         |
| Lapis candidate extraction, source hashing, promotion and maintenance scheduling | `src/memory/lapis/`                                | Vault Markdown records, schema/revision preimages, exclusions and settings remain compatible          |
| Lapis context handoff and transcript hashes                                      | `src/memory/lapis/context-handoff.ts`, `hashes.ts` | Authored transcript stays application-owned; full/delta handoff is prepared only when eligible        |
| Nostr `ControllerMemoryService`                                                  | `src/memory/group/service.ts`                      | Existing partitioned store adapter and injected embedding worker; original 10 consumer tests retained |
| Ranking and recall budgets                                                       | `src/memory/recall.ts`                             | Shared MMR selection; explicit Lapis skip-over-budget and Nostr truncation profiles preserve behavior |

The extraction removes approximately 2,900 lines of duplicate Lapis memory service
implementation. Consumer storage adapters remain necessary: a Vault, encrypted
relay source, signer or Nostr partition policy does not belong in the generic core.
Private Nostr threads select metadata-only retention. Plaintext requests, prompts,
responses, tool inputs and diagnostics are not recoverable from that journal.
Missing private payload is reported as a gap and can only be reconstructed by an
authorized application source.

## Recovery and capability limits

| Boundary                                                         | Implemented behavior                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| SDK disconnect                                                   | Reconnect and atomic snapshot/event replay; no blind mutation replay                                                          |
| Lost submit acknowledgement                                      | Resolve the existing command identity instead of creating a new turn                                                          |
| Controller restart before dispatch                               | Recover accepted work; reauthorize live endpoints before execution                                                            |
| Loss after dispatch / cancellation without terminal confirmation | Explicit unknown/interrupted turn fences the workspace across restart                                                         |
| Uncertain external work known to be stopped                      | Audited `turns resolve --outcome failed                                                                                       | cancelled --stopped`; never replay the old command |
| Tool executor disappears                                         | Unknown write outcome is preserved; no automatic redispatch                                                                   |
| Private payload missing                                          | Explicit status gap; no claim that metadata-only receipt contains plaintext                                                   |
| Native session replacement / reattachment                        | Validate workspace, application reference, endpoints and retention; fresh authorized handoff after Nostr adapter reattachment |
| Native MCP confirmation                                          | Empty form becomes one-time approval; unsupported forms/URL requests fail explicitly instead of hanging                       |
| Native external MCP environments                                 | Environment-name allowlists; no values in argv; conflicting values for the same name fail before launch                       |

No durable independent host event spool or seamless recovery of an in-flight native
agent is claimed. The managed desktop child stops with its owning host; unattended
execution requires running the standalone service. Existing compatibility runtime
exports remain in the AI plugin, but the first-party factory no longer uses them.
External provider executables and accounts are operator prerequisites.

## CLI and packaging

`lapis-ai-controller` implements init, config validation, doctor, status/watch,
service install/start/stop/restart/status/uninstall, logs, provider/model discovery,
thread configuration, turns, events/replay, tools, interactions, context and memory
inspection. Human output and versioned JSON/NDJSON share a typed command tree;
`docs/cli/reference.md` is generated. Credentials use private files or managed
stdin, not command arguments or status output. The compiled executable stages its
runtime dependencies outside the source tree so previous binaries/extraction
caches cannot be recursively embedded. `pnpm local:controller` builds that
binary, atomically installs `~/.local/bin/lapis-ai-controller`, initializes a
missing default config with `--workspace` or `~/.lapis/ai-controller`, reloads
the user service, and waits for an authenticated status handshake.

The new package and current sibling fixes are unpublished. Ignored validation
hooks install built tarballs without modifying tracked registry lockfile entries.
Release must publish dependencies in order and regenerate registry-backed locks:
ai-host, ai-controller and Lapis Community build export, AI plugin, then consumers.
No production service, Nostr signer, package publication or visual baseline was
changed. Do not run old and new providers against the same accepted turn.

Rollback requires stopping the new owner, inspecting uncertain turns and preserving
its database before selecting an older consumer build. Do not replay its accepted
commands through the old path. Vault memory formats and Nostr source stores were
preserved, so no destructive source-data downgrade is required.

## Validation checkpoint

- AI Host: 85 tests plus type/spec/build/publint/pack.
- AI Controller: 63 tests plus boundary/type/spec/build/publint, Deno compilation
  and compiled init/auth/providers/thread/restart/shutdown smoke.
- AI plugin: 364 tests, full repository 785 unit tests, 14 check tasks and 13 build
  tasks; all 176 Storybook interaction/accessibility tests in 39 files; final AI
  rerun 53 tests in seven files; static Storybook build, npm pack, deterministic
  archive reproduction, 12 signature fixtures and App ownership pass.
- Nostr: 140 tests including separate compiled ACP service, restart and private
  plaintext exclusion; Deno source/spec checks and compilation pass.
- Lapis Community build export: focused helper tests, checks/build/publint; full
  unit suite 689 passed and two skipped. The two initial load-sensitive timeouts
  passed exactly and in the bounded full rerun.
- Lapis host: desktop 200 tests including compiled ACP/MCP round trip; web 52;
  root checks/build and API 798/workspace two tests pass.

Lapis root tests still expose an existing profile contradiction: implementation
loads Community as a fifth default plugin, while specification/unit/packaged
acceptance require four. A user choice is pending. Browser and paid-provider
acceptance are recorded separately below as they complete. Release readiness is
not established by the passing unit/build lanes alone.

## Spec-completeness checkpoint

Canonical verification now records every AIC-* requirement as Implemented with
in-repo evidence. Handshake protocol mismatches fail as `protocol_unsupported`
before token comparison. CLI unavailable-service errors keep exit class 3.
Metadata-only journals persist only error codes. Workspace aliases, unsupported
database versions, restricted-mode reattachment, memory-endpoint disposal, Nostr
truncation, group forget exclusions, observational native tool activity and
URL-action MCP elicitations have focused regressions.

First-party Lapis execution already uses the shared SDK and managed child. Nostr
execution uses the same SDK and registers an owner-scoped `nostr.memory`
endpoint so the controller owns recall, search, and get. Publication, registry
lockfile refresh, installed-service deployment and paid-provider acceptance
remain later approved gates.
