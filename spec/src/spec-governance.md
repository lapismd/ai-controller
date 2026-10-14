# Specification governance

The initial release uses spec-validator 0.1.4 and patched source-map tooling.
The optional embedding runtime's Git downloader resolves patched simple-git
and argv-parser versions through explicit workspace overrides. Native model
installation remains a separate operator action; the package audit has no
advisory exceptions.
Normal registry installation resolves the release dependency graph without a
local package hook. The workspace lockfile and audit overrides map to this
chapter, and only the required esbuild dependency build is allowed.

CLI build tooling resolves Arborist 9 and npm-packlist 10 through registry
semver ranges and the frozen pnpm lockfile. Those inventory libraries remain
development dependencies and do not change the installed controller runtime
dependency graph or permit dependency lifecycle scripts during staging.

## Requirements

The public README uses only declared package exports. The independent
`publish-spec-pages.yml` workflow builds the canonical book without installing
runtime dependencies, so spec publication does not depend on npm release gates.

| ID          | Requirement                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AIC-GOV-001 | Canonical chapters MUST be listed in SUMMARY.md and build through mdBook. Generated output MUST be ignored.                                                                                                                   |
| AIC-GOV-002 | Protected behavior changes MUST update the mapped canonical chapter before or with implementation.                                                                                                                            |
| AIC-GOV-003 | Each requirement MUST have one verification row distinguishing implemented evidence from planned work.                                                                                                                        |
| AIC-GOV-004 | The README MUST document npm library installation, authenticated public-client usage, credential and client lifetime ownership, and the separate Deno operator installation path.                                             |
| AIC-GOV-005 | GitHub Actions MUST build canonical `spec/src` with mdBook on specification pull requests and publish the generated book to GitHub Pages only from `main`, including manual dispatch. Generated output MUST remain untracked. |

## Change map

| Protected paths                                                          | Canonical chapter    |
| ------------------------------------------------------------------------ | -------------------- |
| `src/`, `scripts/`, `package.json`, `deno.json`, `docs/`                 | `architecture.md`    |
| `AGENTS.md`, `spec-validator.config.mjs`, `spec/book.toml`, `.gitignore` | `spec-governance.md` |

`AGENTS.md` points operators at the counted-line budgets and import matrix
enforced by AIC-ARCH-001 and AIC-ARCH-002. Organisation plans under
`docs/plans/` remain non-canonical.

Repository-owned npm release helpers and GitHub workflows are protected package
contracts. Their immutable artifact, registry integrity, and tokenless OIDC
publishing checks accompany the existing package validation gates. Private
credentials remain outside source and release artifacts.
