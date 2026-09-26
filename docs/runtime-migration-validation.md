# Deno runtime migration validation

Recorded 2026-09-26 on macOS arm64 with Deno 2.9.7. Tests used disposable installation homes.

## Validation

- Baseline focused CLI/local installer tests: 16 passed.
- `pnpm test`: 38 files, 165 Vitest tests passed; 7 runtime installer tests passed.
- `pnpm spec:check`, `pnpm check`, and `deno task build`: passed.
- `node scripts/smoke-cli.mjs`: cold installed init, authenticated status, providers, threads, restart, managed-child build identity, and shutdown passed.
- The same smoke passed under macOS `sandbox-exec` with outbound network denied except loopback and local sockets. Redaction worker loading passed during installation.

## Package and registry evidence

Logical local snapshot size: 1,580,827 bytes of application/assets/manifest plus 35,690,025 bytes of materialized npm dependencies (37,270,852 bytes total). This excludes the external Deno executable, model caches, and the shared Deno cache. Filesystem allocation and compressed downloads differ.

`deno publish --dry-run --allow-dirty --config artifacts/jsr/deno.json` passed for generated package metadata and graph validation. This is not proof of canonical registry installation: npm returned HTTP 404 for `@lapismd/ai-controller` and `@lapismd/agent-redaction` on this date. Their publication remains a release prerequisite. Local dependency overrides are materialized only in installed snapshots and are absent from publishable manifests.

Local service acceptance covers macOS arm64. Linux and macOS x64/arm64 native coverage remains a CI/release lane; those other hosts were not exercised locally. Existing npm exports are retained. No package was published.

The existing shared Deno cache measured 5,879,692 KiB allocated on this workstation (`du -sk ~/.cache/deno`). This includes unrelated projects and is not an incremental installation cost.
