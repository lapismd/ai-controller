# AI Controller

Shared AI execution orchestration for Lapis, Nostr integrations, and other clients.
Canonical behavior is specified in [the architecture](spec/src/architecture.md).
Implementation and consumer migration evidence is tracked in
[the migration record](spec/records/migration.md).

The controller runs as its own Deno process. `ai-host` supplies execution mechanics;
clients provide domain tools and authorized storage/context endpoints. Native
agent executables and credentials are installed separately.
