# Architecture

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

| ID           | Requirement                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AIC-CORE-001 | Commands MUST commit intent, receipts, events and work atomically before acknowledgement. An owner-scoped repeated key with identical input MUST return its receipt; different input MUST conflict.                          |
| AIC-CORE-002 | Turns MUST serialize per thread and execution workspace. Preparation MUST occur when work is eligible and MUST be recorded before dispatch.                                                                                  |
| AIC-CORE-003 | Startup MUST recover accepted work and mark uncertain dispatch or interrupted execution explicitly. Recovery and replay MUST NOT blindly resubmit prompts or tool effects.                                                   |
| AIC-CORE-004 | Snapshots and replay MUST have an atomic cursor boundary. Runtime output MUST commit before subscriber publication and ingestion acknowledgement.                                                                            |
| AIC-CORE-005 | Private payload policy MUST apply to commands, preparation, events and interactions. Metadata-only threads MUST NOT persist plaintext input, output, context, tool payloads or diagnostic exceptions.                        |
| AIC-CORE-006 | Configuration MUST isolate provider instances and workspaces. Native session replacement and unsupported capabilities MUST be explicit.                                                                                      |
| AIC-TOOL-001 | Tool invocation identity, execution outcome and result delivery MUST be distinct. Non-idempotent unknown outcomes MUST NOT be redispatched automatically.                                                                    |
| AIC-TOOL-002 | Native observed tool activity MUST NOT invoke an application handler. Approval and structured input MUST use distinct typed interactions, authority and liveness checks.                                                     |
| AIC-MEM-001  | Shared memory MUST use authorized storage, search and evidence ports. Consumer adapters MUST retain domain scope authority and source data without implementing a second recall pipeline.                                    |
| AIC-MEM-002  | Recall MUST preserve the selected policy profile, three-record and 900-token default limits, verified evidence, and a 150ms warmed deadline. Injected context MUST remain separate from authored messages.                   |
| AIC-MEM-003  | Maintenance MUST use durable operation identities. Forget exclusions MUST survive rebuilding, and derived replay MUST NOT cause duplicate learning or rewrite source evidence.                                               |
| AIC-API-001  | Every API operation MUST authorize its principal and object scope. The shared client MUST own reconnect and atomic snapshot/event application without resubmitting mutations.                                                |
| AIC-API-002  | Wire and stored schemas MUST be versioned and validated. Unsupported versions MUST fail explicitly and slow subscribers MUST have bounded buffers.                                                                           |
| AIC-CLI-001  | The Deno executable MUST expose typed service, execution, interaction, context and memory commands with generated help, human output, versioned JSON/NDJSON and stable exit classes. Secrets MUST NOT appear in diagnostics. |
| AIC-PKG-001  | Browser SDK exports MUST exclude server and consumer dependencies. Published dependencies MUST use registry semver ranges.                                                                                                   |

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
stdin, never argv. The caller supplies an allowlisted environment and a stable
database path. The child reads generic provider definitions, reports readiness
without credentials, and shares the same service/core as `serve`. Nostr signing
and vault credentials remain outside this interface. Restricted sessions reject
application tools and configure the provider's restricted execution mode.

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
