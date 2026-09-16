# AI Controller

Shared AI execution orchestration for Lapis, Nostr integrations, and other clients.
The controller runs as its own Deno process. `@lapismd/ai-host` supplies execution
mechanics; applications supply authorized tools, context and storage adapters.

## Run locally

Build the verified local dependencies first, then run `pnpm build:cli`. The binary
is `artifacts/lapis-ai-controller`; native agent executables and credentials remain
separate dependencies. During the unpublished migration, use the temporary package
validation setup documented in [the migration record](spec/records/migration.md).

```sh
artifacts/lapis-ai-controller init --workspace /absolute/workspace
artifacts/lapis-ai-controller doctor
artifacts/lapis-ai-controller serve
```

In another terminal:

```sh
artifacts/lapis-ai-controller status --json
artifacts/lapis-ai-controller providers list
artifacts/lapis-ai-controller providers models --provider codex --workspace default
artifacts/lapis-ai-controller threads list --json
```

`init` writes private configuration and token files. Edit the configuration to name
provider instances and workspace roots; credentials grant explicit provider and
workspace access. Use `--config PATH` for an isolated instance. `service` commands
manage a user service on macOS or Linux; building does not install or start one.

See the generated [CLI reference](docs/cli/reference.md) for thread configuration,
idempotent turn submission, cancellation, interactions, tools, prepared context,
memory inspection, replay, service status and logs. JSON/NDJSON output is versioned
and contains no ANSI formatting. Authored message text remains separate from
prepared context.

## Application integration

Use `@lapismd/ai-controller/client` for the browser-safe authenticated SDK and
`@lapismd/ai-controller/runtime` for the session facade. The SDK reconnects and
replays committed state without resubmitting prompts. Applications can launch an
isolated child using `@lapismd/ai-controller/managed`; its credentials travel over
stdin rather than command-line arguments.

Applications register tool, context, memory and external-MCP endpoints. Domain
permissions and source storage remain with the application. The controller invokes
preparation when a queued turn becomes eligible and validates it again at dispatch.
Shared compatibility memory implementations are exported from `/memory/lapis` and
`/memory/group`; they preserve existing records, evidence and forgetting rules.

Durable receipts do not prove an external agent's outcome. `submission-unknown`
and `interrupted` turns fence their execution workspace across restart. Inspect the
external agent and stop remaining work before using:

```sh
artifacts/lapis-ai-controller turns resolve --turn TURN_ID --outcome failed --stopped
```

Resolution is audited and never retries that command. Metadata-only threads retain
identities and status while plaintext remains volatile; lost private payloads are
reported as gaps. Native context restoration depends on provider capabilities.

Canonical behavior is specified in [the architecture](spec/src/architecture.md).
[Migration evidence and release boundaries](spec/records/migration.md) distinguish
fixture validation from live-provider and installed-service acceptance.

Native Codex MCP servers share their parent environment: configured values for
the same environment variable must agree across servers. Conflicting values and
reserved `LAPIS_TOOL_BRIDGE_*` names fail before launch. ACP supports separate
per-server environments. Secrets are never placed in native process arguments.
