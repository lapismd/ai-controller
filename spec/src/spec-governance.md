# Specification governance

## Requirements

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

The README documents authenticated public-client usage and separate operator
installation. The independent specification workflow builds canonical mdBook
source without requiring runtime dependency installation or service activation.
