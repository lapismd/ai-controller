# Architecture

Each prepared turn MUST retain requested and effective approval policy, including
restricted-session suppression. ACP native mode results MUST remain separate:
applied, unsupported, rejected or unreported. Status MUST NOT infer native success
from the requested mode. This metadata survives private payload loss and is
available in snapshots and the ordered owner journal. Policy metadata MUST NOT
mark a turn running or enter the public transcript.

Consumer transcript append and replay allow up to 120 seconds for encrypted
durable storage. Cancellation and disconnect still invalidate the endpoint call;
an expired append never authorizes provider or tool execution.

Canonical message, tool, interaction, checkpoint and parent/child references
are required identities. If scanning changes one, capture emits an omission
instead of retaining a misleading association.

The controller is a separate single-writer service. Applications connect through
the shared SDK and supply authorized tools, context, evidence and storage ports.
The execution library remains `ai-host`. No core module imports a consuming app.
Provider session persistence does not imply recoverable in-flight execution.

The initial implementation records accepted work and committed output in SQLite,
captures events before provider acknowledgements, and re-snapshots SDK clients
after reconnect. A single workspace identifier serializes execution even across
provider instances. Configuration must give each physical workspace one identifier.
Native Codex session IDs are bound separately from turn and command identities.

Memory ports expose scoped candidate retrieval and evidence authorization. The
controller owns recall timing, budgets, rendering and MCP read-tool registration.
Compatibility profiles preserve Lapis skip-over-budget and Nostr truncation
behavior; consumer-specific stores and maintenance migration remain separate work.
Endpoint disposal revokes tools, context and memory registrations immediately.

## Requirements

| ID           | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AIC-CORE-001 | Commands MUST commit intent, receipts, events and work atomically before acknowledgement. An owner-scoped repeated key with identical input MUST return its receipt; different input MUST conflict.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AIC-CORE-002 | Turns MUST serialize per thread and execution workspace. Preparation MUST occur when work is eligible and MUST be recorded before dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AIC-CORE-003 | Startup MUST recover accepted work and mark uncertain dispatch or interrupted execution explicitly. Recovery and replay MUST NOT blindly resubmit prompts or tool effects.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AIC-CORE-004 | Snapshots and replay MUST have an atomic cursor boundary. Runtime output MUST commit before subscriber publication and ingestion acknowledgement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| AIC-CORE-005 | Private payload policy MUST apply to commands, preparation, events and interactions. Metadata-only threads MUST NOT persist plaintext input, output, context, tool payloads or diagnostic exceptions.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AIC-CORE-006 | Configuration MUST isolate provider instances and workspaces. Native session replacement and unsupported capabilities MUST be explicit. ACP turns MUST apply only requested model and thinking through host configure; a harness permission mode MUST be forwarded on ACP session start and MUST NOT be treated as a requested configure field; a host `unsupported` result for a field that was not requested MUST NOT fail the turn. A requested unsupported field MUST fail closed as `unsupported_configuration`.                                                                                                              |
| AIC-CAP-001  | All durable payloads, preparations, interactions, command digests and replay projections MUST pass the configured agent-redaction policy before a first write or export. Native execution inputs MUST remain separate from sanitized model/capture copies. Scanner failure MUST reject input or record an omission, never a raw fallback.                                                                                                                                                                                                                                                                                          |
| AIC-CAP-002  | Observable transcripts MUST use versioned typed events with stable logical identity, ordered sequence, session/turn/attempt/source identity, coverage and sanitization metadata. Public projection MUST retain messages, visible thinking, plans, tools, permissions, input, one latest usage snapshot, errors and cancellation, with coverage remaining metadata on those records. Immediate working and tool status MUST stay projection-only. File operations, commands, lifecycle, checkpoints, compaction, subagents and opaque leftovers MUST NOT become durable rows; unsupported stream boundaries MAY record an omission. |
| AIC-CAP-008  | Observed `tool_call` and `tool_call_update` frames MUST merge into one invocation and result pair that retains kind, title, command and locations. Capture MUST NOT persist null input when those fields exist and MUST fold command into the input object. Durable file, command and patch rows MUST NOT represent the same work. Permission requests MUST reuse that envelope; usage MAY keep an optional numeric cost.                                                                                                                                                                                                          |
| AIC-CAP-003  | Streamed text and visible thinking MUST remain bounded volatile logical blocks until completion and scanning. Immediate working/tool indicators MUST contain only safe status. Cancellation or crash MUST discard unfinished buffers and retain an explicit gap. Transport chunk identity MUST NOT become logical message identity.                                                                                                                                                                                                                                                                                                |
| AIC-CAP-004  | A consumer transcript endpoint MUST authorize owner/application/thread access, support idempotent append and replay, and acknowledge durable capture before subscriber delivery. Metadata-only mode MUST retain no plaintext transcript locally and MUST identify unavailable external history rather than invent recovery.                                                                                                                                                                                                                                                                                                        |
| AIC-CAP-005  | Controller-dispatched tools MUST persist sanitized intent before raw authorized execution and persist sanitized results before provider delivery. Capture failure after effects MUST record outcome/omission and MUST NOT rerun effects. Tool results MUST reference their invocation.                                                                                                                                                                                                                                                                                                                                             |
| AIC-CAP-006  | Replay, summaries, memory indexes and provider-bound context MUST be sanitized derived views. Legacy rows MUST be labelled legacy and re-sanitized before export, without silently rewriting history. Incompatible native sessions MUST require a fresh context handoff.                                                                                                                                                                                                                                                                                                                                                           |
| AIC-CAP-007  | Managed stderr and top-level diagnostics MUST emit scanned complete records or fixed payload-free omissions. No timed partial flush or raw exception fallback is permitted. Nostr signing credentials MUST never enter shared-controller secret matching. The exported process client MUST write the start request immediately after spawn, MUST NOT wait for stdin finish or close, wait at least 60 seconds for readiness, resolve a bare executable from PATH or `$HOME/.local/bin`, and include the readiness cause in start failures without credentials.                                                                     |
| AIC-TOOL-001 | Tool invocation identity, execution outcome and result delivery MUST be distinct. Non-idempotent unknown outcomes MUST NOT be redispatched automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AIC-TOOL-002 | Native observed tool activity MUST NOT invoke an application handler. Approval and structured input MUST use distinct typed interactions, authority and liveness checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AIC-TOOL-003 | When a `ToolCapture` port is configured, mutating `callTool` invocations MUST begin a cooperative span before `endpoint.execute` and finish it after. Capture unavailability MUST fail closed and MUST NOT execute the tool. Stream-only activity MUST use optional `observe` without an exclusive lease and MUST NOT fail the turn. The published controller MUST NOT depend on `jj-checkpoint`.                                                                                                                                                                                                                                  |
| AIC-MEM-001  | Shared memory MUST use authorized storage, search and evidence ports. Consumer adapters MUST retain domain scope authority and source data without implementing a second recall pipeline.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AIC-MEM-002  | Recall MUST preserve the selected policy profile, three-record and 900-token default limits, verified evidence, and a 150ms warmed deadline. Injected context MUST remain separate from authored messages.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AIC-MEM-003  | Maintenance MUST use durable operation identities. Forget exclusions MUST survive rebuilding, and derived replay MUST NOT cause duplicate learning or rewrite source evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AIC-API-001  | Every API operation MUST authorize its principal and object scope. The shared client MUST own reconnect and atomic snapshot/event application without resubmitting mutations.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| AIC-API-002  | Wire and stored schemas MUST be versioned and validated. Unsupported versions MUST fail explicitly and slow subscribers MUST have bounded buffers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AIC-API-003  | WebSocket hello MUST bind or resume a revocable AuthSession. Every later operation MUST authorize through a complete method-to-scope map, then resource ownership. A bootstrap token MUST NOT grant operations without that session. Handshake MUST NOT add authority, and requested scopes MUST NOT widen the credential grant.                                                                                                                                                                                                                                                                                                   |
| AIC-API-004  | Memory and application-tool access MUST use server-derived principal, application and workspace identity. Client-supplied identity, scope or partition fields MUST NOT broaden access. Endpoint registrations MUST be isolated by principal and application. Replay MUST use the same thread authorization as ordinary reads.                                                                                                                                                                                                                                                                                                      |
| AIC-API-005  | `providers.models` MAY accept an optional `sessionId` and MUST forward it to the selected provider. ACP discovery MUST pass that id into host `listAcpModels` so a persisted session can be read without a disposable oneshot. Absent `sessionId` MUST keep the workspace-only discovery path.                                                                                                                                                                                                                                                                                                                                     |
| AIC-CLI-001  | The Deno executable MUST expose typed service, execution, interaction, context and memory commands with generated help, human output, versioned JSON/NDJSON and stable exit classes. Secrets MUST NOT appear in diagnostics.                                                                                                                                                                                                                                                                                                                                                                                                       |
| AIC-CLI-002  | `pnpm local:controller` MUST build the current checkout, atomically install `lapis-ai-controller` at `~/.local/bin/lapis-ai-controller` by default, initialize missing default configuration with `--workspace` or `~/.lapis/ai-controller`, reload the user service, and wait until `status` reports protocol `lapis-ai-controller/1`. It MUST NOT print tokens or private payloads.                                                                                                                                                                                                                                              |
| AIC-PKG-001  | Browser SDK exports MUST exclude server and consumer dependencies. Published dependencies MUST use registry semver ranges.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| AIC-ARCH-001 | `scripts/check-architecture.mjs` MUST enforce counted-line budgets. New production and script files MUST stay at or under 300 counted lines, and new tests at or under 500. Existing files MUST NOT grow without updating `scripts/architecture-baseline.json` in the same change, and a recorded budget MUST fail when the current size plus twenty is still below that budget. |
| AIC-ARCH-002 | Feature modules MUST follow the published import matrix: `cli` MUST NOT import `domain`, `memory`, or `persistence`; `execution` MUST NOT import `transport`; and `client` and `runtime` MUST NOT import `persistence`. Production modules MUST NOT import tests. Dump filenames `utils`, `helpers`, `common`, and `services` MUST be rejected. |

Private payloads remain volatile where the integration selects metadata-only
retention. A durable receipt in that profile covers metadata and external source
identity, not recoverability of plaintext. Loss is reported rather than invented.
Applications retain encrypted delivery stores and can rehydrate authorized data.

The initial storage uses SQLite WAL and FULL synchronous transactions with an
exclusive service instance lock. Distributed writers and a durable host spool
are outside the first release. External provider executables remain external.

Lapis memory compatibility is extracted behind structural evidence, database and
record-store ports. The schema-1 Markdown representation, revision preimages,
source hashes, exclusions, deterministic promotion rules and maintenance leases
remain compatible with existing vault data. The application supplies actual
vault/database access; the shared module never imports App, Vault or UI code.

The group-memory compatibility profile shares ranking policy with the vault
profile and receives scoped evidence/search/mutation ports. It preserves the
existing partition and record schema. Embedding workers are injected resources;
this package does not construct a consumer's worker, relay client or signer.

The shared runtime facade exposes application-neutral session events over the SDK.
It resolves lost turn acknowledgements by command identity and does not retry with
a fresh command. Consumers register preparation endpoints instead of injecting
memory twice. ACP thought output is normalized to reasoning activity, separate
from authored replies. Snapshots include a bounded activity tail and explicitly
report truncation; complete retained history remains available through replay.
Thread configuration uses optimistic versions and rejects changes during work.

Managed application integrations launch the separate controller executable through
an exported process client. Startup credentials travel over the child's private
stdin, never argv. The client writes one newline-delimited request after the
child has spawned, leaves stdin open, and does not wait for stdin finish or
close; compiled Deno pipes may never emit those events, and
`readline.close()` does not close stdin. The default
readiness wait is 60 seconds. Start failures include the readiness cause without
credentials. A bare executable name is resolved from PATH or `$HOME/.local/bin`.
The caller supplies an allowlisted environment and a stable database path. The
child reads generic provider definitions, reports readiness without credentials,
and shares the same service/core as `serve`. Nostr signing and vault credentials
remain outside this interface. Restricted sessions reject application tools and
configure the provider's restricted execution mode.

Runtime facades recognize the stored `payloadUnavailable` event marker and
emit an explicit status gap rather than dropping missing private activity.

The browser runtime accepts a deferred per-turn context port. The SDK registers
that port before submission and the service invokes it only when queued work is
eligible. Port callbacks are volatile capabilities, never serialized into thread
configuration. Resume uses the same endpoint identity and refuses mismatched
scope bindings. Compatibility handoff projection and canonical transcript hashes
are shared library functions; source transcripts remain application-owned.

External MCP launch descriptions travel through an owner-scoped volatile endpoint.
The controller validates them before dispatch and rejects them for restricted
execution or providers without MCP support. Only the endpoint identity persists;
launch environment values are excluded from receipts, preparations, journals and
CLI diagnostics. A disconnected endpoint fails closed. MCP provider activity is
observational and never re-invokes an application tool handler.

The runtime preparation port receives the reserved logical thread identity before
registration so consumers can reconnect the same authorized context endpoint.

CLI compilation stages installed runtime packages in an isolated temporary tree.
Previous executables and extraction caches never enter the next executable.
`pnpm local:controller` is the developer install path: it builds that executable,
replaces `~/.local/bin/lapis-ai-controller` atomically, initializes the default
config only when missing using `--workspace` or `~/.lapis/ai-controller`, then
reloads the user service and waits for an authenticated `status` handshake.
Building alone still does not install or start a service.

Production source already lives under `auth`, `capture`, `cli`, `domain`,
`execution`, `memory`, `persistence`, and `transport`. Domain turn execution,
transcript capture, and endpoint registration live as named modules under
`src/domain/`. Persistence, transport dispatch, and client snapshot helpers
are also named modules beside those facades. Lapis memory episode
documents, search ranking, ingest, inspect, forget, and consolidation live as named
modules under `src/memory/lapis/`. Group memory search, claims, and lifecycle
live as named modules under `src/memory/group/`. Residual root files are
public facades (`client`, `runtime`, `managed`, `contracts`) or composition
roots (`index`, `main`, `service`). For AIC-ARCH-001 and AIC-ARCH-002,
`scripts/check-architecture.mjs` enforces counted-line budgets and that
import matrix. New production and script files must stay at or under 300
counted lines; new tests at or under 500. Existing files must not grow
counted lines without updating `scripts/architecture-baseline.json` in the
same change. A recorded budget fails when the current counted size plus
twenty is still below that budget. Organisation plans under `docs/plans/`
are not canonical requirements.

### AIC-CLI-002 acceptance details

Local controller installation verifies:

- Default install, config, and workspace paths are
  `~/.local/bin/lapis-ai-controller`,
  `~/.config/lapis-ai-controller/config.json`, and `~/.lapis/ai-controller`,
  with `--config`, `--workspace`, `--instance`, and `--install-path` overrides.
- The executable is copied to a temporary sibling and renamed into place.
- A missing config initializes `~/.lapis/ai-controller` unless `--workspace` or
  `LAPIS_AI_CONTROLLER_WORKSPACE` is supplied; an existing config is reused
  without rewriting tokens.
- After service reload, `status --json` reports `lapis-ai-controller/1` and
  command output never includes token bytes or private payloads.

Session reattachment validates application reference, context sources, tool and
memory endpoints, restricted mode and payload policy against the stored thread.
A mismatched attachment fails before it can submit another turn.

Native cancellation retains the workspace lease until the provider confirms a
terminal turn or the confirmation deadline expires. An interrupt request alone
is not proof of completion; an expired confirmation remains interrupted.

Provider setup precedes the persisted dispatch boundary. Setup failures are
failed turns; a lost outcome after dispatch remains submission-unknown or
interrupted. Such a turn fences its workspace across restart. An owner may
resolve it as failed or cancelled only with explicit confirmation that external
work stopped. Resolution records an audit event and releases queued work without
retrying the original command. The CLI exposes this through `turns resolve`.
An owner cancel of that inactive turn is the same confirmation: resolve it as
cancelled and release queued work without retrying the command.

Provider launch defaults come from the installed ai-host/acpx registry. The
controller resolves external executable paths for Deno without replacing adapter
selection or requiring additional global agent binaries.

Startup validates all retained record shapes before recovery starts external work.
Unsupported database versions and malformed records fail closed with payload-free
errors. Metadata-only preparation markers have their own retained schema.
Metadata-only turns persist only short error codes, never exception text.

A handshake with an unsupported protocol version fails as `protocol_unsupported`
before token comparison. Hello then binds a revocable AuthSession from a
bootstrap credential or session bearer. Handshake success grants no extra
authority: every later method has a declared scope, then principal, application,
provider and workspace checks. Missing configuration scopes default to the full
initial set. Existing file and managed tokens remain bootstrap credentials.
Replay and subscriptions are `threads:read`. Mutations stay explicit and
idempotent on command identity. Application tools and memory ports are keyed by
principal and application. Memory adapters receive a server `access` envelope;
client identity fields are stripped. `ai-host` stays an in-process executor and
MUST NOT receive controller-user scopes. A later host service would use a
controller-owned credential, not an application session. WebSocket tickets remain
an unissued seam so long-lived secrets can stay out of socket URLs later.

Two configured identities for one physical workspace fail as `workspace_alias`.
Restricted-mode, endpoint and retention mismatches fail reattachment as
`binding_mismatch`.

### AIC-API-003 acceptance details

Session authorization verifies:

- Hello with a bootstrap token issues or resumes one AuthSession per credential
  and may return a session bearer only when newly issued.
- Hello with a revoked or expired session bearer fails closed.
- A method without a scope-map entry fails in tests; a session missing a
  required scope fails as `forbidden`.
- Reconnect keeps the same AuthSession identity and does not resubmit
  mutations.

### AIC-API-004 acceptance details

Resource isolation verifies:

- Thread `application` is stamped from the session and defaults to `owner` for
  retained rows.
- Another principal or application cannot read the thread, its replay, or its
  private memory.
- Memory `input` cannot override server-derived access fields.
- Application tools cannot be invoked from an unauthorized thread or
  application.

CLI `CliError` codes keep their exit class. Service-manager unavailability uses
exit 3; usage and request failures use exit 2. Secrets still require an explicit
`token show` command.

Native external MCP processes receive explicit environment-name allowlists and
required startup. Values remain in the native process environment, not argv.
Because these servers share one native parent environment, conflicting values
for the same name and reserved application-bridge names fail before launch; ACP
retains server-specific environments.

Native MCP environment regressions run alongside the existing session, context,
approval, structured-input, configuration and resume contract tests.

Native empty-form MCP elicitations are one-time approval interactions. Forms with
fields or URL actions are not treated as approval and receive an unsupported
request error; the adapter never invents required user input. Unknown server
requests receive a JSON-RPC error instead of silently leaving a turn waiting.

Provider configuration MAY include a validated non-secret `vcsIdentity` name and email. ACP sessions MUST bind that identity and replace the native session when it changes. Runtime text events MUST preserve optional logical message IDs and completion markers through the output journal; transport frame IDs remain independent.

Authenticated consumer tool endpoints MAY register a generic capture port. Mutating application tools MUST await its begin acknowledgement before execution and its finish after the result. Read observations remain advisory. Endpoint ownership and disconnect fencing apply to capture callbacks; native ACP effects are observed through the journal and MUST NOT be replayed. Observed ACP tool calls merge start and update frames into one invocation envelope before a durable pair. Command, kind, and locations stay on that envelope; file, command, and patch rows remain forbidden.

The redaction adapter runs pinned credential detectors in an isolated worker.
Synchronous SQLite writes use the same policy through a bounded worker result
buffer; event preparation uses whole logical blocks. Workspace roots are granted
from service configuration. Explicit environment and dotenv grants are private
runtime inputs, never thread configuration or transcript metadata. External ACP
provider traffic and native agent journals remain outside managed coverage.

The new agent-redaction package is initially validated through an explicitly
documented local package archive. Publishing it and upgrading registry lockfiles
remain separate operator gates; publishable manifests keep semver dependencies.

Compiled staging resolves ESM-only dependencies through public import exports and explicitly includes the isolated scanner worker modules.

Derived memory candidates containing reserved redaction or omission markers are rejected rather than promoted as factual memories.

The public contracts export `assertTranscript` for consumer-owned encrypted persistence; validation is shared without exposing storage internals.

Lapis memory ports scan DTOs before indexing and durable writes and scan legacy
reads before derivation. Browser defaults expose portable detector coverage;
consumers can inject an explicit enforcement adapter. Raw authorized evidence
read arguments stay in the execution path. Transformed evidence locations fail
closed instead of becoming file capabilities. Redacted candidates are rejected.

Generic approval policy is `ask` (the default for omitted values) or `allow-all`,
independent of provider-specific permission modes. Allow all resolves only offered
execution approvals, preserving their exact IDs and recording an automatic decision.
Structured task input and restricted sessions never inherit automatic approval.
Each turn uses its durable prepared configuration; changes apply to later turns.
ACP permissions preserve the host deadline rather than extending its lifetime.
Permission resolution must not move a completed, cancelled or failed turn back to
running, and concurrent requests leave the turn waiting until all are resolved.

Host permission settlement is a typed execution event bound to the exact native
interaction and turn. Expired or cancelled host requests remain terminal even
when capture is awaiting durable acknowledgement; replay never opens another
approval. Turn completion cannot be changed by late interaction registration.
The ACP adapter drains settlement handlers without retrying a decision already
settled by the host.

Continuation uses `turns.continue` with the exact prior turn and a new idempotent
command identity. It creates a linked attempt in the same thread with newly
authored instructions, verified sanitized transcript evidence and current
configuration. It MUST reject running, interrupted or submission-unknown work,
pending interactions, unknown tool effects and unavailable metadata-only history.
It MUST NOT cancel, release execution fences, replay the original prompt or rerun
tools. Scope authorization applies to the prior turn; repeated identical commands
return the same receipt and differing input conflicts. Preparation rechecks the
prior outcome and evidence before dispatch.

Metadata-only transcript rows retain the non-content sequence number needed for
ordered replay. Live replay resolves payloads from volatile capture. After loss
of volatile payloads, replay MUST report `transcript_unavailable`; it MUST NOT
return a falsely complete empty history or authorize continuation from it.

Approval-policy provider acceptance is recorded in
[local policy validation](../../docs/local-policy-validation.md). It distinguishes
provider decisions and independently verified file effects from inconclusive
redacted-path probes, browser acceptance and production deployment.

Background group-memory embedding failures MUST be contained before the next
event-loop turn. If capture or durable error recording fails, the in-memory
drain halts and leaves unembedded documents in durable pending state for a later
explicit recovery. It MUST NOT retry against a failed scanner, write raw input,
or crash the consuming service with an unhandled rejection. Closing memory
stops queued work before disposing its capture boundary.
