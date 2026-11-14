# Security graph and version toolchain recovery

Main CI run `43521868050` stopped at `pnpm audit` with seven findings:
six moderate and one low, all from the obsolete Hono 4.13.11 / Node Server 2.1.3
overrides. The exact local audit reproduced all seven findings. Refreshing the
existing bounded override floors to Hono 4.13.16 and Node Server 2.1.6, followed
by `pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile`, leaves zero
full-audit findings. No advisory is suppressed and no dependency source is patched.

Main version workflow `43521868056` stopped inside `pnpm release:version` with
`spawn deno ENOENT`. The shared dependency-automation repository owns that
workflow template. Its fix installs the pinned Deno runtime required by
Changesets 3, while preserving the App token scope, activation gate and
publication separation. Consumer generation and validation follow the owning
source qualification.

The owning template fix is merged as dependency-automation PR #6,
source `b6796c0111fb85fbe7e02bb70b6a6b67b9b63831`, merge
`f1d49eda36b376511dbfb0ac52eda8e310417bf5`.
Its focused runtime regression changed from one pass/one failure to two passes;
all 23 tests, workflow linting, 18 generated Renovate configurations and the
read-only inventory pass. This repository consumes the exact source-owned
workflow template, rather than adding a consumer-specific workaround.

Final consumer validation passes the exact full audit (7 findings to 0),
production audit (0), all four specification lanes, type/architecture/boundary
checks, 196 unit cases, all seven Deno runtime cases, build, both release-helper
cases, package lint and immutable npm candidate preparation. Doctor passes;
the QMD-disabled discovery command reports its explicit fallback. All hosted
workflow files pass actionlint.

The real `pnpm release:version` command also passes in an isolated Jujutsu
checkout with the qualified source and normal registry installation. It prepares
0.1.1 while this source checkout remains 0.1.0. The fixture publishes nothing
and starts no controller service. Source preparation is distinct from the
subsequent version PR and protected publication.
