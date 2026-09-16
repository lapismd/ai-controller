# Verification

| ID | Status | Evidence |
| --- | --- | --- |
| AIC-CORE-001 | Implemented | src/persistence/store.test.ts; src/domain/engine.test.ts |
| AIC-CORE-002 | Implemented | src/domain/engine.test.ts; workspace identifier serialization |
| AIC-CORE-003 | Implemented | src/persistence/store.test.ts; conservative unknown and interruption states |
| AIC-CORE-004 | Implemented | src/persistence/store.test.ts; src/transport/server.test.ts |
| AIC-CORE-005 | Implemented | src/persistence/store.test.ts; private command, output, preparation, tool payloads and diagnostic exceptions |
| AIC-CORE-006 | Implemented | src/service.test.ts; src/persistence/store.test.ts; src/runtime.test.ts restricted reattachment |
| AIC-TOOL-001 | Implemented | src/domain/engine.test.ts; src/transport/server.test.ts |
| AIC-TOOL-002 | Implemented | src/domain/engine.test.ts; src/execution/compat/app-server-protocol.test.ts |
| AIC-MEM-001 | Implemented | src/transport/server.test.ts; src/memory/lapis/native-memory-service.test.ts |
| AIC-MEM-002 | Implemented | src/memory/recall.test.ts; src/transport/server.test.ts |
| AIC-MEM-003 | Implemented | src/memory/lapis/native-memory-service.test.ts; src/memory/group/service.test.ts |
| AIC-API-001 | Implemented | src/transport/server.test.ts; src/runtime.test.ts |
| AIC-API-002 | Implemented | src/transport/server.test.ts; src/persistence/store.test.ts |
| AIC-API-003 | Implemented | src/auth/scopes.test.ts; src/auth/session.test.ts; src/transport/server.test.ts session authorization |
| AIC-API-004 | Implemented | src/transport/server.test.ts memory and tool isolation; src/auth/authorize.test.ts |
| AIC-CLI-001 | Implemented | src/cli/cli.test.ts; docs/cli/reference.md |
| AIC-CLI-002 | Implemented | scripts/local-controller.test.mjs; src/cli/cli.test.ts default workspace |
| AIC-PKG-001 | Implemented | scripts/check-boundaries.mjs; pnpm publint |
| AIC-GOV-001 | Implemented | pnpm spec:check |
| AIC-GOV-002 | Implemented | pnpm spec:check |
| AIC-GOV-003 | Implemented | pnpm spec:check |
