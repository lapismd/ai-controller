# AI Controller

[![npm version](https://img.shields.io/npm/v/%40lapismd%2Fai-controller)](https://www.npmjs.com/package/@lapismd/ai-controller)

Shared AI execution orchestration for Lapis, Nostr integrations, and other clients.
The controller runs as its own Deno process. `@lapismd/ai-host` supplies execution
mechanics; applications supply authorized tools, context and storage adapters.

## Install the client library

```sh
npm install @lapismd/ai-controller
# or
pnpm add @lapismd/ai-controller
```

The package is ESM and includes TypeScript declarations. Its browser-safe
`/client` export connects to an already running controller; installing the npm
library does not install or start the Deno service. Use the checkout instructions
below for that service. Node applications should use Node.js 22 or newer; the
operator CLI requires Deno 2.9.5 or newer and separately installed agent tools.

## Use an existing controller

Obtain the controller WebSocket URL and an authorized token from your host or
operator. The default local service listens at `ws://127.0.0.1:7346`; deployment
configuration can change it. Keep tokens out of URLs, logs and source control.

```ts
import { ControllerClient } from "@lapismd/ai-controller/client";

export async function readThread(url: string, token: string, threadId: string) {
  const client = new ControllerClient({ url, token });
  try {
    await client.connect();
    return await client.snapshot(threadId);
  } finally {
    client.dispose();
  }
}
```

For a long-lived application, retain one client and dispose it at host teardown.
`token` may also be an async callback that retrieves the current authorized
credential. The SDK supports subscriptions, reconnect and committed-state replay.

After the operator configures a provider and grants your workspace access:

```ts
import { ControllerClient } from "@lapismd/ai-controller/client";

export async function queuePrompt(
  client: ControllerClient,
  threadId: string,
  commandId: string,
  text: string,
) {
  return await client.submit({ threadId, commandId, text });
}
```

Create a thread once using `client.createThread({ provider, workspace })` with
configured provider and workspace identifiers. Persist its ID and a command ID
for each submission. Retry the same command with the same ID and payload only;
the returned receipt confirms durable acceptance, not provider completion.
Use `client.subscribe(threadId, listener)` to follow snapshots and call its
returned unsubscribe function when the view closes. Register application-owned
tool, context and memory endpoints through `client.registerEndpoint()`.

| Import                                                    | Purpose                                     |
| --------------------------------------------------------- | ------------------------------------------- |
| `@lapismd/ai-controller/client`                           | Authenticated browser-safe client           |
| `@lapismd/ai-controller/contracts`                        | Shared request, receipt and state contracts |
| `@lapismd/ai-controller/runtime`                          | Session integration facade                  |
| `@lapismd/ai-controller/managed`                          | Host-managed controller process             |
| `@lapismd/ai-controller/memory`                           | Memory ports and policies                   |
| `@lapismd/ai-controller/memory/lapis` and `/memory/group` | Compatibility memory implementations        |

## Run locally

Clone [the repository](https://github.com/lapismd/ai-controller) and install its
registry dependencies before building or installing the CLI:

```sh
pnpm install --frozen-lockfile
```

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
[The published specification](https://lapismd.github.io/ai-controller/) is built
from `spec/src` and deployed by GitHub Actions on `main`.
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
