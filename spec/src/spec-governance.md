# Specification governance

## Requirements

| ID | Requirement |
| --- | --- |
| AIC-GOV-001 | Canonical chapters MUST be listed in SUMMARY.md and build through mdBook. Generated output MUST be ignored. |
| AIC-GOV-002 | Protected behavior changes MUST update the mapped canonical chapter before or with implementation. |
| AIC-GOV-003 | Each requirement MUST have one verification row distinguishing implemented evidence from planned work. |

## Change map

| Protected paths | Canonical chapter |
| --- | --- |
| `src/`, `scripts/`, `package.json`, `deno.json`, `docs/` | `architecture.md` |
| `AGENTS.md`, `spec-validator.config.mjs`, `spec/book.toml`, `.gitignore` | `spec-governance.md` |

`AGENTS.md` points operators at the counted-line budgets and import matrix
enforced by AIC-ARCH-001 and AIC-ARCH-002. Organisation plans under
`docs/plans/` remain non-canonical.
