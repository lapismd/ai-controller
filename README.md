# AI Controller

Shared AI execution orchestration for Lapis, Nostr integrations, and other clients.
The controller runs as its own Deno process. `@lapismd/ai-host` supplies execution
mechanics; applications supply authorized tools, context and storage adapters.

## Run locally

The developer install path matches Nostr's `pnpm local:agent`. It builds the
current checkout, atomically installs `~/.local/bin/lapis-ai-controller`,
initializes the default configuration when needed, reloads the user service, and
waits until `status` reports `lapis-ai-controller/1`:

```sh
pnpm local:controller
```

`pnpm local:agent` is the same task. Pass `--workspace /absolute/workspace`
after `--` to override the first-run default.

After setup, ordinary commands need no path override:

```sh
lapis-ai-controller status --json
lapis-ai-controller doctor
lapis-ai-controller providers list
```

Defaults are `~/.config/lapis-ai-controller/config.json`,
`~/.local/bin/lapis-ai-controller`, and workspace `~/.lapis/ai-controller`.
Override with `--config`, `--instance`, `--install-path`, or `--workspace` after
`--`. The command never prints tokens or private payloads.

To install a checkout snapshot without installing a user service, use
`deno task install:cli` and invoke `lapis-ai-controller` on PATH. Native
agent executables and credentials remain separate dependencies. During the
unpublished migration, use the temporary package validation setup documented
in [the migration record](spec/records/migration.md).

`init` writes private configuration and token files. Edit the configuration to name
provider instances and workspace roots; credentials grant explicit provider and
workspace access. Use `--config PATH` for an isolated instance.

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

## Installed Deno CLI

Install Deno 2.9.5 or newer, then run `deno task install:cli` in this checkout.
The command installs a verified snapshot and a launcher in `~/.local/bin`;
add that directory to `PATH` once. Run `lapis-ai-controller --help` from any directory.
Use `deno task install:cli --install-path /absolute/path/lapis-ai-controller` to
choose another launcher location, or `--home /temporary/home` for acceptance.
Code and dependencies live under `~/.local/lib/lapis-ai-controller/releases/<digest>`.
Re-run installation to update; checkout edits do not affect installed snapshots.
Installation does not restart a running service. Existing operator lifecycle
commands retain their explicit service activation behavior.

The artifact requires external Deno; it contains no Deno executable. Previous
snapshots are retained for processes that still use them. The launcher records
the Deno path, so reinstall the CLI if Deno moves. Runtime packages include a
file inventory and SHA-256 digest; build revision is captured during packaging.

`deno task build` creates `artifacts/runtime` and `artifacts/jsr`.
`deno task test:runtime` checks snapshot installation, and `deno task jsr:check`
validates publication without uploading. Once this package and its dependencies
are released, version-pinned JSR installation will be:

```sh
deno install --global --root ~/.local --allow-all --name lapis-ai-controller jsr:@lapismd/ai-controller@VERSION/cli
```

Replace `VERSION` with a released version. JSR publishing is a separate manual
step. Published manifests use registry dependencies; ignored `deno.local.json`
overrides are materialized only for local runtime validation, never published.
