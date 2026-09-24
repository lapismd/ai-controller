# Verification

| ID | Status | Evidence |
| --- | --- | --- |
| AIC-CORE-001 | Implemented | src/persistence/store.test.ts; src/domain/engine.test.ts |
| AIC-CORE-002 | Implemented | src/domain/engine.test.ts; workspace identifier serialization |
| AIC-CORE-003 | Implemented | src/persistence/store.test.ts; conservative unknown and interruption states |
| AIC-CORE-004 | Implemented | src/persistence/store.test.ts; src/transport/server.test.ts |
| AIC-CORE-005 | Implemented | src/persistence/store.test.ts; private command, output, preparation, tool payloads and diagnostic exceptions |
| AIC-CORE-006 | Implemented | src/service.test.ts; src/persistence/store.test.ts; src/runtime.test.ts restricted reattachment; execution ACP identity/session-boundary tests; ACP configure helper tests keep host-invented unsupported thinking non-fatal and fail closed only for requested fields; transport server read/write capture callback ordering and disconnect tests |
| AIC-TOOL-001 | Implemented | src/domain/engine.test.ts; src/transport/server.test.ts |
| AIC-TOOL-002 | Implemented | engine, approval-policy, acp-permission-policy and transport-schema tests cover Ask defaults, exact offered Allow all decisions and audit, restricted sessions, task input, host deadlines, and unsupported options. |
| AIC-TOOL-003 | Implemented | src/domain/engine.test.ts wraps mutating tools with cooperative capture, fails closed when begin throws, and records observed activity without exclusive begin |
| AIC-MEM-001 | Implemented | src/transport/server.test.ts; src/memory/lapis/native-memory-service.test.ts |
| AIC-MEM-002 | Implemented | src/memory/recall.test.ts; src/transport/server.test.ts |
| AIC-MEM-003 | Implemented | src/memory/lapis/native-memory-service.test.ts; src/memory/group/service.test.ts |
| AIC-API-001 | Implemented | src/transport/server.test.ts; src/runtime.test.ts |
| AIC-API-002 | Implemented | src/transport/server.test.ts; src/persistence/store.test.ts |
| AIC-API-003 | Implemented | src/auth/scopes.test.ts; src/auth/session.test.ts; src/transport/server.test.ts session authorization |
| AIC-API-004 | Implemented | src/transport/server.test.ts memory and tool isolation; src/auth/authorize.test.ts |
| AIC-API-005 | Implemented | Transport server test forwards optional `providers.models` sessionId; ACP provider test passes that id to `listAcpModels`. |
| AIC-CLI-001 | Implemented | src/cli/cli.test.ts; docs/cli/reference.md |
| AIC-CLI-002 | Implemented | scripts/local-controller.test.mjs; src/cli/cli.test.ts default workspace |
| AIC-PKG-001 | Implemented | scripts/check-boundaries.mjs; pnpm publint |
| AIC-GOV-001 | Implemented | pnpm spec:check |
| AIC-GOV-002 | Implemented | pnpm spec:check |
| AIC-GOV-003 | Implemented | pnpm spec:check |
| AIC-CAP-001 | Implemented | src/persistence/sanitization.test.ts inspects first SQL bindings; src/memory/group/capture-store.test.ts checks index ingress/replay |
| AIC-CAP-002 | Implemented | src/capture/session.test.ts; public allowlist without lifecycle or extension leftovers; one usage snapshot after several updates; src/execution/compat/acp-event-mapper.test.ts folds tool_call_update into the same tool pair |
| AIC-CAP-008 | Implemented | src/execution/compat/tool-snapshot.test.ts extracts command and merges updates; src/capture/session.test.ts keeps original args and name across a thin tool_call_update; src/execution/compat/acp-event-mapper.test.ts maps command, locations, permission envelope and optional usage cost |
| AIC-CAP-003 | Implemented | src/capture/session.test.ts whole logical messages, thinking, immediate fixed status and interruption gaps |
| AIC-CAP-004 | Implemented | src/transport/transcript.test.ts owner authorization, durable acknowledgment before execution, remote encrypted-journal deadline and metadata-only replay |
| AIC-CAP-005 | Implemented | src/persistence/sanitization.test.ts raw tool execution and sanitized model results; existing unknown-outcome recovery tests |
| AIC-CAP-006 | Implemented | Group capture-store and Lapis native-memory-service tests cover first index writes and legacy reads; execution location capabilities remain separate |
| AIC-CAP-007 | Implemented | Managed stderr buffers complete EOF with bounded scan; local compiled binary starts its isolated scanner and persists a policy-bearing thread; start does not await stdin finish; start writes resolve without stdin close; start failures include the readiness cause; bare names resolve from PATH or `$HOME/.local/bin` |
